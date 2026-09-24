import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import { RunRecorder } from "./run-recorder.js";
import type { ProviderCall } from "./provider.js";
import { validateRunResult } from "./run-result.js";

const call: ProviderCall = {
  requestedModel: "jev-latest",
  model: "jev-test",
  attempts: 1,
  usage: { inputTokens: 20, outputTokens: 4 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};

function fakeSession(text: string) {
  const version = {
    document: "doc",
    route: "https://store.test/",
    revision: 1,
  };
  const page = {
    url: version.route,
    closed: false,
    goto: vi.fn(async (url: string) => ({ url })),
    settle: vi.fn(async () => ({ settled: true, elapsedMs: 1 })),
    close: vi.fn(async () => {}),
    evaluate: vi.fn(async (expression: string) => {
      const value = expression.includes('bridge["quiet"]')
        ? { quiet: true, version }
        : expression.includes('bridge["digest"]')
          ? { protocol: 1, version, text, complete: true }
          : version;
      return { installed: true, protocol: 1, value };
    }),
  };
  return {
    newContext: vi.fn(async () => ({
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {}),
  };
}

describe("runFlow in parallel lanes", () => {
  it("routes concurrent attempts to their own tests and never shares privacy state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-parallel-runner-"));
    try {
      const files = ["one", "two", "three"].map((name) =>
        path.join(root, `${name}.test.yaml`),
      );
      for (const [index, file] of files.entries())
        await writeFile(
          file,
          `url: https://store.test/\ndata:\n  token: $TOKEN_${index}\nsteps:\n  - verify the cart total is $42\n  - verify the cart total is $42\n`,
        );
      const recorder = new RunRecorder(async (snapshot) => {
        validateRunResult(snapshot);
      }, "parallel-run");
      await recorder.start();
      await recorder.selectTests(files.length);
      const privacy = { secretValues: [] as string[], sensitiveOrigins: [] };
      // Judge replies finish in reverse order so the three flows interleave.
      const results = await Promise.all(
        files.map((file, ordinal) =>
          runFlow(file, {
            repoRoot: root,
            browser: {
              launch: vi.fn(async () =>
                fakeSession(`Cart total is $42; token secret-${ordinal}`),
              ),
            } as never,
            provider: {
              classifyBatch: vi.fn(),
              choose: vi.fn(),
              holds: vi.fn(async () => {
                await new Promise((resolve) =>
                  setTimeout(resolve, (files.length - ordinal) * 5),
                );
                // A failing claim records the judged excerpt, so redaction shows.
                return { holds: 0.05, contradicted: 0.95, call };
              }),
            },
            classificationCache: new NoopClassificationCache(),
            env: { [`TOKEN_${ordinal}`]: `secret-${ordinal}` },
            report: {
              recorder,
              slot: { ordinal, lane: ordinal },
              privacy,
              evidenceEnabled: false,
              replay: false,
              saveFrame: vi.fn(),
            },
          }),
        ),
      );
      expect(results.map((result) => result.status)).toEqual([
        "failed",
        "failed",
        "failed",
      ]);
      expect(privacy.secretValues).toEqual([]);
      await recorder.finish();
      const snapshot = recorder.snapshot;
      expect(snapshot.tests.map((test) => test.file)).toEqual([
        "one.test.yaml",
        "two.test.yaml",
        "three.test.yaml",
      ]);
      for (const [ordinal, test] of snapshot.tests.entries()) {
        const attempt = test.attempts[0]!;
        expect(attempt.lane).toBe(ordinal);
        expect(attempt.steps.map((step) => step.index)).toEqual([1]);
        expect(attempt.verdict).toBe("failed");
        expect(
          attempt.steps.every((step) => step.id.startsWith(attempt.id)),
        ).toBe(true);
        // Each attempt redacted its own secret out of the judged excerpt.
        const excerpts = attempt.steps
          .map((step) => step.judgement?.judgedExcerpt ?? "")
          .join(" ");
        expect(excerpts).toContain("Cart total is $42");
        expect(excerpts).not.toContain(`secret-${ordinal}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
