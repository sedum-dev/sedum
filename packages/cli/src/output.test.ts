import {
  RunRecorder,
  type ResultCall,
  type ResultStep,
  type RunResult,
} from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import {
  clearProgress,
  renderProgress,
  renderRunSummary,
  type OutputCapabilities,
  type RunArtifactPaths,
} from "./output.js";

const plain: OutputCapabilities = {
  stdoutIsTTY: false,
  stderrIsTTY: false,
  color: false,
};

const artifacts: RunArtifactPaths = {
  progressPath: "runs/characterization/progress.json",
  resultPath: "runs/characterization/result.json",
  htmlPath: "runs/characterization/report.html",
  markdownPath: "runs/characterization/report.md",
  junitPath: "runs/characterization/junit.xml",
  reporterPath: "copies/result.json",
  authoritative: true,
};

function call(overrides: Partial<ResultCall> = {}): ResultCall {
  return {
    purpose: "locator",
    requestedModel: "requested-model",
    model: "actual-model",
    attempts: 1,
    inputTokens: 11,
    outputTokens: 7,
    apiMs: 125,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    rateSource: "fixture",
    rateCheckedAt: "2026-01-02T03:04:05.000Z",
    costUsd: 0.000025,
    ...overrides,
  };
}

function step(
  id: string,
  index: number,
  overrides: Partial<ResultStep> = {},
): ResultStep {
  return {
    id,
    index,
    kind: "action",
    operation: "click",
    phase: "steps",
    sentence: `click ${id}`,
    detail: "",
    sourceStack: [{ file: "checkout.test.yaml", line: index + 1, col: 5 }],
    state: "completed",
    verdict: "passed",
    flags: [],
    elapsedMs: 10,
    page: { status: "omitted", reason: "fixture" },
    locator: null,
    judgement: null,
    observations: [],
    calls: [],
    error: null,
    evidence: { status: "omitted", reason: "fixture" },
    replayFrame: null,
    targetBox: null,
    ...overrides,
  };
}

async function configureComprehensiveRun(recorder: RunRecorder): Promise<void> {
  await recorder.selectTests(3, {
    parallel: { requested: 3, lanes: 2 },
    shard: { index: 2, count: 3, globalSelectedTests: 8 },
    providerConcurrency: 4,
    vision: { model: "vision-model", key: "rejected" },
  });
  await recorder.addDiscoveryProblems([
    {
      file: "broken.test.yaml",
      line: 7,
      col: 9,
      code: "invalid_test",
      message: "Could not parse test.",
      fix: "Repair the YAML.",
    },
    {
      file: "missing.test.yaml",
      code: "missing_test",
      message: "Test disappeared.",
      fix: "Restore the file.",
    },
  ]);
  await recorder.addSetupCalls([
    call({
      purpose: "classification",
      rateLimited: true,
      rateLimitWaitMs: 1250,
    }),
  ]);
}

function historicalStep(): ResultStep {
  return step("historical", 1, {
    verdict: "failed",
    error: { code: "no_match", message: "No match." },
    locator: {
      confidence: null,
      source: "none",
      options: [],
      cache: null,
      vision: {
        outcome: "selected",
        reason: "provider\u001b[31mmetadata",
        elapsedMs: 2100,
      },
    },
    calls: [call({ modality: "vision" })],
  });
}

function cachedStep(): ResultStep {
  return step("cached", 2, {
    flags: ["low_confidence", "contradiction"],
    locator: {
      confidence: 0.7,
      source: "model",
      options: [],
      cache: {
        outcome: "miss",
        reason: "outside_git",
        fallbackCalledModel: true,
        targetChanged: true,
      },
    },
    calls: [call({ rateLimited: true, rateLimitWaitMs: 2300 })],
  });
}

function conflictStep(): ResultStep {
  return step("conflict", 3, {
    locator: {
      confidence: 0.9,
      source: "model",
      options: [],
      cache: {
        outcome: "miss",
        reason: "conflict",
        fallbackCalledModel: false,
        targetChanged: false,
      },
      vision: { elapsedMs: 300, failure: "timeout" },
    },
  });
}

async function recordCheckout(recorder: RunRecorder): Promise<void> {
  const checkout = await recorder.beginTest({
    id: "checkout",
    file: "checkout.test.yaml",
    description: "checkout",
    ordinal: 0,
    lane: 0,
  });
  await checkout.addStep(historicalStep());
  await checkout.finishTest("failed");
  await checkout.startAttempt(1);
  await checkout.addStep(cachedStep());
  await checkout.addStep(conflictStep());
  await checkout.finishTest("passed");
}

async function recordErroredTest(recorder: RunRecorder): Promise<void> {
  const errored = await recorder.beginTest({
    id: "errored",
    file: "errored.test.yaml",
    ordinal: 1,
    lane: 1,
  });
  await errored.addStep(
    step("errored-click", 1, {
      state: "error",
      verdict: null,
      error: { code: "browser_error", message: "Browser closed." },
    }),
  );
  await errored.errorTest({
    code: "browser_error",
    message: "Browser closed.",
  });
}

async function comprehensiveResult(): Promise<RunResult> {
  const recorder = new RunRecorder(async () => undefined, "output-fixture");
  await recorder.start();
  await configureComprehensiveRun(recorder);
  await recordCheckout(recorder);
  await recordErroredTest(recorder);
  await recorder.finish({ code: "execution_error", message: "Run stopped." });
  return recorder.snapshot;
}

async function resultWithLabel(
  verdict: "passed" | "failed" | null,
  state: "completed" | "interrupted" | "running" | "error",
): Promise<RunResult> {
  const recorder = new RunRecorder(async () => undefined, `label-${state}`);
  await recorder.start();
  if (state === "running") return recorder.snapshot;
  if (state === "completed") {
    await recorder.startTest({ id: "label", file: "label.test.yaml" });
    await recorder.addStep(
      step("label-step", 1, {
        verdict,
        error:
          verdict === "failed"
            ? { code: "assertion_failed", message: "Failed." }
            : null,
      }),
    );
    await recorder.finishTest(verdict!);
    await recorder.finish();
    return recorder.snapshot;
  }
  await recorder.finish(
    { code: "execution_error", message: "Stopped." },
    state,
  );
  return recorder.snapshot;
}

describe("terminal output characterization", () => {
  it("renders a feature-complete summary byte-for-byte", async () => {
    const output = renderRunSummary(
      await comprehensiveResult(),
      { stdoutIsTTY: true, stderrIsTTY: true, color: true, columns: 73 },
      artifacts,
      false,
    );

    expect(output).toMatchInlineSnapshot(`
      "checkout.test.yaml
        attempts 2 (failed -> passed)
        step 2: cache miss (outside_git), model fallback, target changed
        step 3: cache miss (conflict)
      cache off: this project is not a Git checkout; run \`git init\` to cache locator results
      run  [31mERROR[0m
      discovery broken.test.yaml:7:9: Could not parse test. Fix: Repair the YAML.
      discovery missing.test.yaml: Test disappeared. Fix: Restore the file.
      tests 3 selected, 2 executed, 1 passed, 0 failed, 1 could not run
      flags 1 flagged step(s), low_confidence 1, contradiction 1, flaky 1 test(s)
      lanes 2, provider concurrency 4, shard 2/3 of 8 selected
      vision vision-model: attempted on 2 step(s); 1 selected, 0 abstained, 1 failed
      vision not attempted on 1 failed click step(s); see step errors for details
      vision warning: OpenRouter rejected OPEN_ROUTER_API_KEY, so vision fallback cannot work. Check it with \`sedum doctor --vision\`.
      provider rate limited 2 call(s), waited 3.5s in shared cooldowns
      cache 1 locator cache write conflict(s); the model result was used
      checkout.test.yaml · attempt 1 · step 1: Vision fallback: selected · actual-model · 2100 ms · trigger: provider [31mmetadata
      checkout.test.yaml · attempt 2 · step 3: Vision fallback: failed · model unrecorded · 300 ms · timeout
      result runs/characterization/result.json
      html runs/characterization/report.html
      markdown runs/characterization/report.md
      junit runs/characterization/junit.xml
      reporter copies/result.json
      Text models: 2 calls · 22 input tokens · 14 output tokens · recorded cost $0.000050
      Vision models: 1 calls · 11 input tokens · 7 output tokens · recorded cost $0.000025
      Vision outcomes: 1 selected · 0 abstained · 1 failed
      All models (all attempts): 3 calls · 33 input tokens · 21 output tokens · recorded cost $0.000075
      "
    `);
    expect(output.endsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(false);
  });

  it("keeps redirected, unavailable-artifact, and hidden-cost boundaries exact", async () => {
    const result = await comprehensiveResult();
    expect(
      renderRunSummary(
        result,
        plain,
        { ...artifacts, authoritative: false },
        false,
      ),
    ).toMatchInlineSnapshot(`
      "checkout.test.yaml
        attempts 2 (failed -> passed)
        step 2: cache miss (outside_git), model fallback, target changed
        step 3: cache miss (conflict)
      cache off: this project is not a Git checkout; run \`git init\` to cache locator results
      run  ERROR
      discovery broken.test.yaml:7:9: Could not parse test. Fix: Repair the YAML.
      discovery missing.test.yaml: Test disappeared. Fix: Restore the file.
      tests 3 selected, 2 executed, 1 passed, 0 failed, 1 could not run
      flags 1 flagged step(s), low_confidence 1, contradiction 1, flaky 1 test(s)
      lanes 2, provider concurrency 4, shard 2/3 of 8 selected
      vision vision-model: attempted on 2 step(s); 1 selected, 0 abstained, 1 failed
      vision not attempted on 1 failed click step(s); see step errors for details
      vision warning: OpenRouter rejected OPEN_ROUTER_API_KEY, so vision fallback cannot work. Check it with \`sedum doctor --vision\`.
      provider rate limited 2 call(s), waited 3.5s in shared cooldowns
      cache 1 locator cache write conflict(s); the model result was used
      checkout.test.yaml · attempt 1 · step 1: Vision fallback: selected · actual-model · 2100 ms · trigger: provider [31mmetadata
      checkout.test.yaml · attempt 2 · step 3: Vision fallback: failed · model unrecorded · 300 ms · timeout
      result unavailable (intended runs/characterization/result.json)
      "
    `);
  });

  it.each([
    ["passed", "completed", "PASSED"],
    ["failed", "completed", "FAILED"],
    [null, "interrupted", "INTERRUPTED"],
    [null, "running", "INCOMPLETE"],
    [null, "error", "ERROR"],
  ] as const)(
    "preserves the %s/%s run label",
    async (verdict, state, label) => {
      const output = renderRunSummary(
        await resultWithLabel(verdict, state),
        plain,
        { ...artifacts, authoritative: false },
        false,
      );
      expect(output.split("\n").find((line) => line.startsWith("run  "))).toBe(
        `run  ${label}`,
      );
    },
  );

  it("preserves progress control bytes and color independently of summaries", async () => {
    const result = await comprehensiveResult();
    expect(renderProgress(result, plain)).toBe("");
    expect(clearProgress(plain)).toBe("");
    expect(
      renderProgress(result, { ...plain, stdoutIsTTY: true, color: false }),
    ).toBe("\r\u001b[2KRUNNING errored.test.yaml");
    expect(
      renderProgress(result, { ...plain, stdoutIsTTY: true, color: true }),
    ).toBe("\r\u001b[2K\u001b[36mRUNNING\u001b[0m errored.test.yaml");
    expect(clearProgress({ ...plain, stdoutIsTTY: true })).toBe("\r\u001b[2K");
  });
});
