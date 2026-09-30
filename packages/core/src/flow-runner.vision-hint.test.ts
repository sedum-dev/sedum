import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import { RunRecorder } from "./run-recorder.js";

describe("vision fallback feedback", () => {
  it("says why vision was not tried for a click with no match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-vision-hint-"));
    try {
      const file = path.join(root, "main.test.yaml");
      await writeFile(file, "steps:\n  - click the photo of the grey top\n");
      const version = {
        document: "doc-1",
        route: "https://example.test/",
        revision: 1,
      };
      const candidates = ["Add to cart", "Remove"].map((name, index) => ({
        ref: `ref-${index}`,
        tag: "button",
        role: "button",
        name,
        peers: [],
        editable: false,
        disabled: false,
        inputType: "",
        signals: { path: `html/body/button:${index}` },
      }));
      const page = {
        url: version.route,
        closed: false,
        title: vi.fn(async () => "Example"),
        text: vi.fn(async () => "Example"),
        settle: vi.fn(async () => ({ settled: true, elapsedMs: 1 })),
        goto: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        evaluate: vi.fn(async (expression: string) => {
          const value = expression.includes('bridge["quiet"]')
            ? { quiet: true, version }
            : expression.includes('bridge["collect"]')
              ? {
                  protocol: 1,
                  version,
                  total: candidates.length,
                  offset: 0,
                  next: null,
                  complete: true,
                  candidates,
                }
              : version;
          return { installed: true, protocol: 1, value };
        }),
      };
      const session = {
        newContext: vi.fn(async () => ({
          newPage: vi.fn(async () => page),
          close: vi.fn(async () => {}),
        })),
        close: vi.fn(async () => {}),
      };
      const choose = vi.fn(async () => ({
        selection: { kind: "none" as const },
        probabilities: { "ref-0": 0.03, "ref-1": 0.03, none: 0.94 },
        confidence: 0.94,
        call: {
          requestedModel: "test-model",
          model: "test-model",
          attempts: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          rate: null,
          successfulResponseCostUsd: null,
          totalCostUsd: null,
        },
      }));
      const vision = vi.fn();
      const recorder = new RunRecorder(async () => {}, "vision-hint");
      await recorder.start();
      const result = await runFlow(file, {
        repoRoot: root,
        browser: { launch: vi.fn(async () => session) } as never,
        provider: { classifyBatch: vi.fn(), choose, holds: vi.fn() },
        visionResolver: { choose: vision },
        classificationCache: new NoopClassificationCache(),
        env: {},
        baseUrl: version.route,
        report: {
          recorder,
          privacy: { secretValues: [] },
          evidenceEnabled: false,
          replay: false,
          saveFrame: vi.fn(),
        },
      });
      expect(result.status).toBe("failed");
      expect(vision).not.toHaveBeenCalled();
      expect(
        recorder.snapshot.tests[0]?.attempts[0]?.steps[0]?.error?.message,
      ).toBe(
        "Could not resolve this click step. Vision fallback was not tried: the text model found no matching element, and vision only breaks ties between repeated controls.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
