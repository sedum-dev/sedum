import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import type { Judge } from "./provider.js";
import { RunRecorder } from "./run-recorder.js";

const call = {
  requestedModel: "test-model",
  model: "test-model",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};

async function run(steps: readonly string[], holds = 0.95) {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-ops-"));
  try {
    const file = path.join(root, "ops.test.yaml");
    await writeFile(
      file,
      `data:\n  sku: backpack\nsteps:\n${steps.map((step) => `  - ${JSON.stringify(step)}`).join("\n")}\n`,
    );
    const version = {
      document: "doc-1",
      route: "https://example.test/",
      revision: 1,
    };
    const page = {
      url: version.route,
      closed: false,
      title: vi.fn(async () => "Example"),
      text: vi.fn(async () => "Example page text"),
      settle: vi.fn(async () => ({ settled: true, elapsedMs: 1 })),
      goto: vi.fn<(url: string) => Promise<void>>(async () => {}),
      press: vi.fn<(key: string) => Promise<void>>(async () => {}),
      scroll: vi.fn<(deltaY: number) => Promise<void>>(async () => {}),
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async (expression: string) => {
        if (expression === "window.innerHeight") return 1000;
        const value = expression.includes('bridge["quiet"]')
          ? { quiet: true, version }
          : expression.includes('bridge["digest"]')
            ? { protocol: 1, version, text: "Example page", complete: true }
            : version;
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
    const judge = vi.fn<Judge["holds"]>(async () => ({
      holds,
      contradicted: 1 - holds,
      call,
    }));
    const recorder = new RunRecorder(async () => {}, "ops-run");
    await recorder.start();
    const result = await runFlow(file, {
      repoRoot: root,
      browser: { launch: vi.fn(async () => session) } as never,
      provider: { classifyBatch: vi.fn(), choose: vi.fn(), holds: judge },
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
    const steps_ = recorder.snapshot.tests[0]?.attempts[0]?.steps ?? [];
    return { result, page, judge, steps: steps_ };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("documented step operations", () => {
  it("waits for the named duration", async () => {
    const started = performance.now();
    const outcome = await run(["wait 300 ms"]);
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe(
      "passed",
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
    expect(outcome.steps.map((step) => [step.operation, step.verdict])).toEqual(
      [["wait", "passed"]],
    );
  });

  it("presses the named key with Playwright key names", async () => {
    const outcome = await run([
      "press Enter",
      "press the escape key",
      'press "ctrl+a"',
    ]);
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe(
      "passed",
    );
    expect(outcome.page.press.mock.calls.map(([key]) => key)).toEqual([
      "Enter",
      "Escape",
      "Control+a",
    ]);
  });

  it("scrolls one screenful in the named direction", async () => {
    const outcome = await run(["scroll down", "scroll up"]);
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe(
      "passed",
    );
    expect(outcome.page.scroll.mock.calls.map(([delta]) => delta)).toEqual([
      800, -800,
    ]);
  });

  it("navigates to the address, substituting data without displaying it", async () => {
    const outcome = await run([
      "goto https://example.test/items/{{sku}}?ref=1.",
    ]);
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe(
      "passed",
    );
    // The first call is the entry URL.
    expect(outcome.page.goto.mock.calls.at(-1)?.[0]).toBe(
      "https://example.test/items/backpack?ref=1",
    );
    expect(outcome.steps[0]?.detail).toBe(
      "Opened https://example.test/items/{{sku}}?ref=1.",
    );
  });

  it("measures a claim without gating the test", async () => {
    const outcome = await run(
      ["measure whether a list of products is shown"],
      0.05,
    );
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe(
      "passed",
    );
    expect(outcome.judge.mock.calls[0]?.[0]).toBe(
      "a list of products is shown",
    );
    expect(outcome.steps[0]).toMatchObject({
      kind: "measure",
      verdict: null,
      flags: [],
      judgement: { holds: 0.05, threshold: null, band: null },
    });
  });
});
