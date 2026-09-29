import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import { captureVisionObservation, VisionRequestError } from "./vision.js";
import { RunRecorder } from "./run-recorder.js";
import { validateRunResult } from "./run-result.js";

vi.mock("./vision.js", async (original) => ({
  ...(await original<typeof import("./vision.js")>()),
  captureVisionObservation: vi.fn(),
}));

describe("action retry boundary", () => {
  async function runClick(
    firstReason: "stale" | "action_started",
    options: { vision?: boolean; sensitive?: boolean; failure?: boolean } = {},
  ) {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-action-retry-"));
    try {
      const file = path.join(root, "click.test.yaml");
      await writeFile(
        file,
        "url: https://store.test/cart\nsteps:\n  - click the Checkout button\n",
      );
      const version = {
        document: "doc-1",
        route: "https://store.test/cart",
        revision: 1,
      };
      const candidate = {
        ref: "checkout-ref",
        tag: "button",
        role: "button",
        name: "Checkout",
        peers: [],
        editable: false,
        disabled: false,
        inputType: "",
        signals: { path: "html/body/button:0" },
      };
      const candidatePage = {
        protocol: 1,
        version,
        total: options.vision ? 2 : 1,
        offset: 0,
        next: null,
        complete: true,
        candidates: [candidate],
      };
      if (options.vision)
        candidatePage.candidates.push({
          ...candidate,
          ref: "second-ref",
          signals: { path: "html/body/button:1" },
        });
      vi.mocked(captureVisionObservation).mockClear();
      vi.mocked(captureVisionObservation).mockResolvedValue({
        candidates: candidatePage.candidates,
        observation: {
          instruction: "click Checkout",
          image: new Uint8Array(),
          candidates: candidatePage.candidates.map((c, i) => ({
            id: `C${i + 1}`,
            name: c.name,
            role: c.role,
          })),
        },
      });
      let actionEffects = 0;
      const clickRef = vi
        .fn()
        .mockResolvedValueOnce({
          actionable: false,
          reason: firstReason,
          retryable: firstReason === "stale",
        })
        .mockImplementation(async () => {
          actionEffects++;
          return { actionable: true, aim: {} };
        });
      const page = {
        url: version.route,
        closed: false,
        goto: vi.fn(async (url: string) => ({ url })),
        close: vi.fn(async () => {}),
        clickRef,
        evaluate: vi.fn(async (expression: string) => {
          const value = expression.includes('bridge["quiet"]')
            ? { quiet: true, version }
            : expression.includes('bridge["collect"]') ||
                expression.includes('bridge["findBySignals"]')
              ? candidatePage
              : expression.includes('bridge["clickTarget"]')
                ? {
                    actionable: true,
                    aim: {
                      ref: candidate.ref,
                      ...version,
                      tag: candidate.tag,
                      name: candidate.name,
                      point: { x: 5, y: 5 },
                    },
                  }
                : version;
          return { installed: true, protocol: 1, value };
        }),
      };
      const choose = vi.fn(async () => ({
        selection: { kind: "candidate" as const, id: candidate.ref },
        probabilities: {
          [candidate.ref]: options.vision ? 0.8 : 0.9,
          ...(options.vision ? { "second-ref": 0.1 } : {}),
          none: 0.1,
        },
        confidence: 0.9,
        call: {
          requestedModel: "test",
          model: "test",
          attempts: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          rate: null,
          successfulResponseCostUsd: null,
          totalCostUsd: null,
        },
      }));
      const visionChoose = vi.fn(async () => {
        const { call } = await choose.mock.results[0]!.value;
        if (options.failure)
          throw new VisionRequestError(
            "rate-limited",
            "http_error",
            123,
            call,
            429,
          );
        return { decision: { kind: "candidate" as const, id: "C2" }, call };
      });
      const recorder = new RunRecorder(async () => {}, "vision-run");
      await recorder.start();
      const put = vi.fn();
      const result = await runFlow(file, {
        repoRoot: root,
        browser: {
          launch: vi.fn(async () => ({
            newContext: vi.fn(async () => ({
              newPage: vi.fn(async () => page),
              close: vi.fn(async () => {}),
            })),
            close: vi.fn(async () => {}),
          })),
        } as never,
        provider: { choose, holds: vi.fn(), classifyBatch: vi.fn() },
        ...(options.vision ? { visionResolver: { choose: visionChoose } } : {}),
        locatorCache: {
          key: new Uint8Array(32).fill(9),
          lookup: async () => ({ reason: "absent" as const }),
          put,
          invalidate: vi.fn(),
          clear: vi.fn(),
        },
        report: {
          recorder,
          privacy: {
            secretValues: [],
            sensitiveOrigins: options.sensitive ? ["https://store.test"] : [],
          },
          evidenceEnabled: false,
          replay: false,
          saveFrame: async () => ({
            status: "unavailable" as const,
            reason: "capture_unavailable" as const,
          }),
        },
        classificationCache: new NoopClassificationCache(),
        env: {},
      });
      await recorder.finish(
        result.status === "could_not_run"
          ? { code: "execution_error", message: result.message }
          : null,
      );
      validateRunResult(recorder.snapshot);
      return {
        result,
        choose,
        clickRef,
        actionEffects,
        visionChoose,
        put,
        report: recorder.snapshot,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("re-resolves once after a pre-dispatch stale result", async () => {
    const run = await runClick("stale");
    expect(run.result.status).toBe("passed");
    expect(run.choose).toHaveBeenCalledTimes(2);
    expect(run.clickRef).toHaveBeenCalledTimes(2);
    expect(run.actionEffects).toBe(1);
  });

  it("does not retry an action that may have started", async () => {
    const run = await runClick("action_started");
    expect(run.result.status).toBe("could_not_run");
    expect(run.choose).toHaveBeenCalledTimes(1);
    expect(run.clickRef).toHaveBeenCalledTimes(1);
    expect(run.actionEffects).toBe(0);
  });
  it("does not re-resolve, dispatch, or cache after a vision-selected target becomes stale", async () => {
    const run = await runClick("stale", { vision: true });
    expect(run.result.status).toBe("could_not_run");
    expect(run.visionChoose).toHaveBeenCalledTimes(1);
    expect(run.choose).toHaveBeenCalledTimes(1);
    expect(run.clickRef).toHaveBeenCalledTimes(1);
    expect(run.actionEffects).toBe(0);
    expect(run.put).not.toHaveBeenCalled();
  });
  it("keeps strict selection when sensitive-page policy suppresses vision", async () => {
    const run = await runClick("stale", { vision: true, sensitive: true });
    expect(run.result.status).toBe("failed");
    expect(captureVisionObservation).not.toHaveBeenCalled();
    expect(run.visionChoose).not.toHaveBeenCalled();
    expect(run.clickRef).not.toHaveBeenCalled();
    expect(run.put).not.toHaveBeenCalled();
  });
  it("preserves safe vision error diagnostics in the canonical report", async () => {
    const run = await runClick("stale", { vision: true, failure: true });
    expect(run.result.status).toBe("failed");
    expect(run.report.tests[0]?.attempts[0]?.steps[0]?.locator?.vision).toEqual(
      { failure: "http_error", httpStatus: 429, elapsedMs: 123 },
    );
    expect(
      run.report.tests[0]?.attempts[0]?.steps[0]?.error?.message,
    ).toContain("vision http_error (HTTP 429)");
    expect(run.clickRef).not.toHaveBeenCalled();
    expect(run.visionChoose).toHaveBeenCalledTimes(1);
  });
});
