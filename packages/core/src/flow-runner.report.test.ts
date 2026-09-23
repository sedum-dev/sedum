import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import { RunRecorder } from "./run-recorder.js";
import type { ProviderCall } from "./provider.js";
import { ProviderError } from "./provider.js";
import type { RunResult } from "./run-result.js";

const call: ProviderCall = {
  requestedModel: "jev-latest",
  model: "jev-test",
  attempts: 1,
  usage: { inputTokens: 20, outputTokens: 4 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};

async function reportRun(
  sensitive = false,
  providerFails = false,
  navigateAfterJudge = false,
  retry = false,
  staleFirstJudge = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-report-runner-"));
  try {
    const file = path.join(root, "cart.test.yaml");
    await writeFile(file, "steps:\n  - verify the cart total is $42\n");
    const route = "https://store.test/cart?token=hidden";
    const version = { document: "doc-1", route, revision: 1 };
    let currentVersion = version;
    let versionReads = 0;
    const captureFrame = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const page = {
      url: route,
      closed: false,
      goto: vi.fn(async (url: string) => ({ url })),
      title: vi.fn(async () => "Private Cart"),
      captureFrame,
      settle: vi.fn(async () => ({ settled: true, elapsedMs: 1 })),
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async (expression: string) => {
        if (expression.includes('bridge["pageVersion"]')) {
          const answer = currentVersion;
          versionReads++;
          if (navigateAfterJudge && versionReads === 2) {
            page.url = "https://public.test/next";
            currentVersion = {
              document: "doc-2",
              route: page.url,
              revision: 1,
            };
          }
          return { installed: true, protocol: 1, value: answer };
        }
        const value = expression.includes('bridge["quiet"]')
          ? { quiet: true, version: currentVersion }
          : expression.includes('bridge["digest"]')
            ? {
                protocol: 1,
                version: currentVersion,
                text: "Cart total is $0; customer secret-123",
                complete: true,
              }
            : currentVersion;
        return { installed: true, protocol: 1, value };
      }),
    };
    const context = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    const session = {
      newContext: vi.fn(async () => context),
      close: vi.fn(async () => {}),
    };
    const snapshots: RunResult[] = [];
    const recorder = new RunRecorder(async (value) => {
      snapshots.push(structuredClone(value));
    }, "report-run");
    await recorder.start();
    const saveFrame = vi.fn(async () => ({
      status: "captured" as const,
      path: "evidence/frame.jpg",
      mediaType: "image/jpeg" as const,
    }));
    let judgeCalls = 0;
    const dependencies = {
      repoRoot: root,
      browser: { launch: vi.fn(async () => session) } as never,
      provider: {
        classifyBatch: vi.fn(),
        choose: vi.fn(),
        holds: vi.fn(async () => {
          judgeCalls++;
          if (providerFails)
            throw new ProviderError("timeout", "Timeout with secret-123", 2);
          if (staleFirstJudge && judgeCalls === 1) {
            currentVersion = { document: "doc-2", route, revision: 1 };
          }
          return {
            holds: retry && judgeCalls > 1 ? 0.9 : 0.1,
            contradicted: retry && judgeCalls > 1 ? 0.1 : 0.9,
            call: staleFirstJudge
              ? { ...call, model: `jev-test-${judgeCalls}` }
              : call,
          };
        }),
      },
      classificationCache: new NoopClassificationCache(),
      env: {},
      baseUrl: route,
      report: {
        recorder,
        privacy: {
          secretValues: ["secret-123"],
          sensitiveOrigins: sensitive ? ["https://store.test"] : [],
        },
        evidenceEnabled: true,
        replay: false,
        saveFrame,
      },
    };
    const result = await runFlow(file, dependencies);
    if (result.status === "could_not_run" && !providerFails)
      throw new Error(result.message);
    if (retry) {
      await recorder.startAttempt();
      const retried = await runFlow(file, dependencies);
      if (retried.status !== "passed")
        throw new Error(`Retry did not pass: ${retried.status}`);
    }
    await recorder.finish(
      providerFails
        ? { code: "execution_error", message: "The run could not complete." }
        : null,
    );
    return {
      result,
      final: recorder.snapshot,
      snapshots,
      saveFrame,
      captureFrame,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("runner report facts", () => {
  it("publishes a failed verify with exact scores, safe page and default frame", async () => {
    const { result, final, snapshots, saveFrame } = await reportRun();
    expect(result.status).toBe("failed");
    expect(final.tests[0]?.id).toBe("cart.test.yaml");
    expect(
      snapshots.some(
        (snapshot) => snapshot.tests[0]?.attempts[0]?.steps.length === 1,
      ),
    ).toBe(true);
    expect(final).toMatchObject({
      state: "completed",
      verdict: "failed",
      totals: {
        failedTests: 1,
        failedSteps: 1,
        modelCalls: 1,
        inputTokens: 20,
      },
    });
    expect(final.tests[0]?.attempts[0]?.steps[0]).toMatchObject({
      verdict: "failed",
      page: {
        status: "available",
        url: "https://store.test/cart",
        title: "Private Cart",
      },
      judgement: {
        holds: 0.1,
        contradicted: 0.9,
        threshold: 0.75,
        judgedExcerpt: "Cart total is $0; customer [REDACTED]",
      },
      evidence: { status: "captured", path: "evidence/frame.jpg" },
    });
    expect(saveFrame).toHaveBeenCalledOnce();
    expect(JSON.stringify(final)).not.toContain("hidden");
    expect(JSON.stringify(final)).not.toContain("secret-123");
  });

  it("suppresses page details and pixels for a sensitive origin", async () => {
    const { final, saveFrame, captureFrame } = await reportRun(true);
    expect(final.tests[0]?.attempts[0]?.steps[0]).toMatchObject({
      page: { status: "omitted", reason: "sensitive_page" },
      judgement: { judgedExcerpt: null },
      evidence: { status: "omitted", reason: "sensitive_page" },
    });
    expect(saveFrame).not.toHaveBeenCalled();
    expect(captureFrame).not.toHaveBeenCalled();
    expect(JSON.stringify(final)).not.toContain("Private Cart");
  });

  it("keeps judged sensitive evidence private across a post-judge navigation", async () => {
    const { final, saveFrame, captureFrame } = await reportRun(
      true,
      false,
      true,
    );
    expect(final.tests[0]?.attempts[0]?.steps[0]).toMatchObject({
      page: { status: "unavailable", reason: "stale_page" },
      judgement: { judgedExcerpt: null },
      evidence: { status: "omitted", reason: "sensitive_page" },
    });
    expect(saveFrame).not.toHaveBeenCalled();
    expect(captureFrame).not.toHaveBeenCalled();
    expect(JSON.stringify(final)).not.toContain("customer");
  });

  it("keeps a failed provider attempt with unknown cost in the partial receipt", async () => {
    const { result, final } = await reportRun(false, true);
    expect(result.status).toBe("could_not_run");
    expect(final).toMatchObject({
      state: "error",
      verdict: null,
      totals: { modelCalls: 2, costUsd: null, costComplete: false },
    });
    expect(final.tests[0]?.attempts[0]?.steps[0]?.calls[0]).toMatchObject({
      purpose: "judge",
      attempts: 2,
      costUsd: null,
    });
    expect(JSON.stringify(final)).not.toContain("secret-123");
  });

  it("uses attempt-scoped step IDs when the runner executes a whole-test retry", async () => {
    const { final } = await reportRun(false, false, false, true);
    const attempts = final.tests[0]!.attempts;
    expect(attempts.map((attempt) => attempt.verdict)).toEqual([
      "failed",
      "passed",
    ]);
    expect(attempts[0]!.steps[0]!.id).not.toBe(attempts[1]!.steps[0]!.id);
    expect(final).toMatchObject({
      verdict: "passed",
      totals: {
        passedTests: 1,
        failedTests: 0,
        historicalAttempts: 1,
        failedSteps: 0,
      },
    });
  });

  it("retains both successful judge receipts across a stale-observation retry", async () => {
    const { final } = await reportRun(false, false, false, false, true);
    expect(
      final.tests[0]?.attempts[0]?.steps[0]?.calls.map((entry) => entry.model),
    ).toEqual(["jev-test-1", "jev-test-2"]);
    expect(final).toMatchObject({
      totals: { modelCalls: 2, inputTokens: 40, outputTokens: 8 },
    });
  });

  it("marks an absent action target as a failed step, not an operational error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-absent-action-"));
    try {
      const file = path.join(root, "absent.test.yaml");
      await writeFile(file, "steps:\n  - click the missing button\n");
      const route = "https://store.test/cart";
      const version = { document: "doc-1", route, revision: 1 };
      let currentVersion = version;
      const page = {
        url: route,
        closed: false,
        goto: vi.fn(async (url: string) => ({ url })),
        title: vi.fn(async () => "Cart"),
        captureFrame: vi.fn(async () => new Uint8Array([1])),
        close: vi.fn(async () => {}),
        evaluate: vi.fn(async (expression: string) => {
          if (expression.includes('bridge["pageVersion"]')) {
            const answer = currentVersion;
            if (currentVersion === version) {
              page.url = "https://store.test/next";
              currentVersion = {
                document: "doc-2",
                route: page.url,
                revision: 1,
              };
            }
            return { installed: true, protocol: 1, value: answer };
          }
          const value = expression.includes('bridge["quiet"]')
            ? { quiet: true, version }
            : expression.includes('bridge["collect"]')
              ? {
                  protocol: 1,
                  version,
                  total: 0,
                  offset: 0,
                  next: null,
                  complete: true,
                  candidates: [],
                }
              : currentVersion;
          return { installed: true, protocol: 1, value };
        }),
      };
      const context = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {}),
      };
      const session = {
        newContext: vi.fn(async () => context),
        close: vi.fn(async () => {}),
      };
      const recorder = new RunRecorder(async () => {}, "absent-run");
      await recorder.start();
      const choose = vi.fn();
      const result = await runFlow(file, {
        repoRoot: root,
        browser: { launch: vi.fn(async () => session) } as never,
        provider: { classifyBatch: vi.fn(), choose, holds: vi.fn() },
        classificationCache: new NoopClassificationCache(),
        env: {},
        baseUrl: route,
        report: {
          recorder,
          privacy: { secretValues: [] },
          evidenceEnabled: true,
          replay: false,
          saveFrame: vi.fn(async () => ({
            status: "captured" as const,
            path: "evidence/absent.jpg",
            mediaType: "image/jpeg" as const,
          })),
        },
      });
      await recorder.finish();
      expect(result.status).toBe("failed");
      expect(recorder.snapshot).toMatchObject({
        state: "completed",
        verdict: "failed",
        error: null,
        totals: { failedSteps: 1, failedTests: 1 },
      });
      expect(recorder.snapshot.tests[0]?.attempts[0]?.steps[0]).toMatchObject({
        kind: "action",
        verdict: "failed",
        error: { code: "no_candidates" },
        locator: { source: "none" },
        page: { status: "unavailable", reason: "stale_page" },
        evidence: { status: "unavailable", reason: "stale_frame" },
      });
      expect(choose).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never pairs a replay box with a frame after the aimed target rerenders", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-replay-race-"));
    try {
      const file = path.join(root, "click.test.yaml");
      await writeFile(file, "steps:\n  - click the Checkout button\n");
      const route = "https://store.test/cart";
      const old = { document: "doc-1", route, revision: 1 };
      let current = old;
      const candidate = {
        ref: "r1",
        tag: "button",
        role: "button",
        name: "Checkout",
        peers: [],
        editable: false,
        disabled: false,
        inputType: "",
        signals: { path: "body/button:0" },
      };
      const captureFrame = vi.fn(async () => new Uint8Array([1]));
      const page = {
        url: route,
        closed: false,
        goto: vi.fn(async (url: string) => ({ url })),
        title: vi.fn(async () => "Cart"),
        captureFrame,
        close: vi.fn(async () => {}),
        clickRef: vi.fn(async () => ({
          actionable: false as const,
          reason: "stale" as const,
          retryable: true,
        })),
        evaluate: vi.fn(async (expression: string) => {
          let value: unknown;
          if (expression.includes('bridge["quiet"]'))
            value = { quiet: true, version: old };
          else if (expression.includes('bridge["collect"]'))
            value = {
              protocol: 1,
              version: old,
              total: 1,
              offset: 0,
              next: null,
              complete: true,
              candidates: [candidate],
            };
          else if (expression.includes('bridge["findBySignals"]'))
            value = {
              protocol: 1,
              version: old,
              total: 1,
              offset: 0,
              next: null,
              complete: true,
              candidates: [{ ...candidate, ref: "fresh-r1" }],
            };
          else if (expression.includes('bridge["clickTarget"]')) {
            value = {
              actionable: true,
              aim: {
                ref: "fresh-r1",
                ...old,
                tag: "button",
                name: "Checkout",
                point: { x: 10, y: 10 },
                box: { x: 0.2, y: 0.3, width: 0.1, height: 0.05 },
              },
            };
            current = { document: "doc-2", route, revision: 1 };
          } else value = current;
          return { installed: true, protocol: 1, value };
        }),
      };
      const context = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {}),
      };
      const session = {
        newContext: vi.fn(async () => context),
        close: vi.fn(async () => {}),
      };
      const recorder = new RunRecorder(async () => {}, "replay-race-run");
      await recorder.start();
      const saveFrame = vi.fn(async () => ({
        status: "captured" as const,
        path: "evidence/replay.jpg",
        mediaType: "image/jpeg" as const,
      }));
      const result = await runFlow(file, {
        repoRoot: root,
        browser: { launch: vi.fn(async () => session) } as never,
        provider: {
          classifyBatch: vi.fn(),
          holds: vi.fn(),
          choose: vi.fn(async () => ({
            selection: { kind: "candidate" as const, id: "r1" },
            probabilities: { r1: 0.8, none: 0.2 },
            confidence: 0.8,
            call,
          })),
        },
        classificationCache: new NoopClassificationCache(),
        env: {},
        baseUrl: route,
        report: {
          recorder,
          privacy: { secretValues: [] },
          evidenceEnabled: true,
          replay: true,
          saveFrame,
        },
      });
      expect(result.status).toBe("could_not_run");
      await recorder.finish({
        code: "execution_error",
        message: "The run could not complete.",
      });
      expect(recorder.snapshot.tests[0]?.attempts[0]?.steps[0]).toMatchObject({
        replayFrame: { status: "unavailable", reason: "stale_frame" },
        targetBox: null,
        evidence: { status: "unavailable", reason: "stale_frame" },
      });
      expect(captureFrame).not.toHaveBeenCalled();
      expect(saveFrame).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
