import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";

describe("action retry boundary", () => {
  async function runClick(firstReason: "stale" | "action_started") {
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
        total: 1,
        offset: 0,
        next: null,
        complete: true,
        candidates: [candidate],
      };
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
        probabilities: { [candidate.ref]: 0.9, none: 0.1 },
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
        classificationCache: new NoopClassificationCache(),
        env: {},
      });
      return { result, choose, clickRef, actionEffects };
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
});
