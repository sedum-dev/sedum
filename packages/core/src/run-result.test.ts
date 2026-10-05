import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { RunRecorder } from "./run-recorder.js";
import {
  ResultCallSchema,
  RunResultSchema,
  resultTotals,
  runResultJsonSchema,
  validateRunResult,
  type RunResult,
  type ResultStep,
} from "./run-result.js";
import { safeText, safeUrl } from "./report-privacy.js";

const frame = { status: "omitted" as const, reason: "clean_step" };
const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 1000,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;
function step(
  id: string,
  verdict: "passed" | "failed",
  flags: ResultStep["flags"] = [],
): ResultStep {
  return {
    id,
    index: 1,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence: "verify the cart",
    detail: "",
    sourceStack: [{ file: "cart.test.yaml", line: 2, col: 5 }],
    state: "completed",
    verdict,
    flags,
    elapsedMs: 10,
    page: {
      status: "available",
      observationId: `${id}:observation:1`,
      url: "https://example.test/cart",
      title: "Cart",
    },
    locator: null,
    judgement: {
      holds: 0.8,
      contradicted: 0.1,
      threshold: 0.75,
      band: 0.15,
      contradictionCutoff: 0.5,
      judgedExcerpt: verdict === "failed" ? "Cart empty" : null,
    },
    observations: [
      {
        id: `${id}:observation:1`,
        ordinal: 1,
        elapsedMs: 10,
        outcome: "accepted",
        reason: null,
        timeoutReason: null,
      },
    ],
    calls: [],
    error: null,
    evidence: frame,
    replayFrame: null,
    targetBox: null,
  };
}

async function recordedResult(
  verdict: "passed" | "failed" = "passed",
): Promise<RunResult> {
  const recorder = new RunRecorder(async () => {}, `run-${verdict}`);
  await recorder.start();
  await recorder.startTest({ id: `test-${verdict}`, file: "cart.test.yaml" });
  await recorder.addStep(step(`step-${verdict}`, verdict));
  await recorder.finishTest(verdict);
  await recorder.finish();
  return recorder.snapshot;
}

function copyResult(result: RunResult): RunResult {
  return structuredClone(result);
}

function refreshTotals(result: RunResult): void {
  result.totals = resultTotals(
    result.tests,
    result.setupCalls,
    result.selectedTestCount ?? result.tests.length,
  );
}

function expectDiagnostic(result: RunResult, message: string): void {
  expect(() => validateRunResult(result)).toThrow(new Error(message));
}

describe("canonical RunResult", () => {
  it("accepts legacy calls without identity and round-trips provider identity", () => {
    const legacy = {
      purpose: "planner",
      requestedModel: "legacy-model",
      model: "legacy-model",
      attempts: 1,
      inputTokens: 1,
      outputTokens: 1,
      apiMs: null,
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      rateSource: null,
      rateCheckedAt: null,
      costUsd: null,
    };
    expect(ResultCallSchema.parse(legacy)).not.toHaveProperty("provider");
    expect(
      ResultCallSchema.parse({ ...legacy, provider: "clef" }),
    ).toMatchObject({
      provider: "clef",
    });
    expect(() => ResultCallSchema.parse({ ...legacy, provider: "" })).toThrow();
  });

  it("publishes schema-valid live and final snapshots with report fields", async () => {
    const snapshots = [] as ReturnType<typeof validateRunResult>[];
    const recorder = new RunRecorder(async (value) => {
      snapshots.push(structuredClone(value));
    }, "run-1");
    await recorder.start();
    await recorder.startTest({
      id: "test-1",
      file: "cart.test.yaml",
      description: "cart",
      tags: ["checkout"],
    });
    await recorder.addStep(step("step-1", "passed", ["low_confidence"]));
    await recorder.finishTest("passed");
    await recorder.finish();
    expect(snapshots).toHaveLength(5);
    expect(
      snapshots.every((item) => validateRunResult(item).runId === item.runId),
    ).toBe(true);
    const final = recorder.snapshot;
    expect(final).toMatchObject({
      state: "completed",
      verdict: "passed",
      flags: ["low_confidence"],
      totals: { selectedTests: 1, passedTests: 1, flaggedSteps: 1 },
    });
    expect(final.tests[0]?.attempts[0]?.steps[0]).toMatchObject({
      sentence: "verify the cart",
      sourceStack: [{ file: "cart.test.yaml", line: 2, col: 5 }],
      judgement: { holds: 0.8, threshold: 0.75 },
      page: { title: "Cart" },
    });
    expect(runResultJsonSchema()).toMatchObject({
      $id: "https://sedum.dev/schemas/run-result/v1",
    });
  });

  it("keeps historical retry usage separate from selected outcome", () => {
    const prior = {
      id: "attempt-1",
      ordinal: 1,
      state: "completed" as const,
      verdict: "failed" as const,
      flags: [] as ResultStep["flags"],
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      elapsedMs: 1000,
      timeoutReason: null,
      error: null,
      steps: [
        {
          ...step("step-failed", "failed"),
          calls: [
            {
              purpose: "judge" as const,
              requestedModel: "model",
              model: "model",
              attempts: 1,
              inputTokens: 10,
              outputTokens: 2,
              apiMs: 10,
              inputUsdPerMillion: 1,
              outputUsdPerMillion: 1,
              rateSource: "test",
              rateCheckedAt: "2026-01-01",
              costUsd: 0.000012,
            },
          ],
        },
      ],
      problems: [
        {
          id: "attempt-1:problem:1",
          ordinal: 1,
          origin: "step" as const,
          outcome: "failed" as const,
          phase: "steps" as const,
          sourceStack: [{ file: "cart.test.yaml", line: 2, col: 5 }],
          stepId: "step-failed",
          error: { code: "step_failed", message: "The step failed." },
        },
      ],
      primaryProblemId: "attempt-1:problem:1",
    };
    const selected = {
      ...prior,
      id: "attempt-2",
      ordinal: 2,
      verdict: "passed" as const,
      steps: [step("step-passed", "passed")],
      problems: [],
      primaryProblemId: null,
    };
    const test = {
      id: "test",
      file: "cart.test.yaml",
      description: "",
      tags: [],
      state: "completed" as const,
      verdict: "passed" as const,
      flags: [],
      selectedAttemptId: "attempt-2",
      attempts: [prior, selected],
    };
    expect(resultTotals([test])).toMatchObject({
      passedTests: 1,
      failedTests: 0,
      passedSteps: 1,
      failedSteps: 0,
      historicalAttempts: 1,
      modelCalls: 1,
      costUsd: 0.000012,
    });
  });

  it("retains a failed whole-test attempt when a retry passes", async () => {
    const recorder = new RunRecorder(async () => {}, "run-retry");
    await recorder.start();
    await recorder.startTest({ id: "test-retry", file: "cart.test.yaml" });
    const classification = {
      purpose: "classification" as const,
      requestedModel: "jev",
      model: "jev",
      attempts: 1,
      inputTokens: 10,
      outputTokens: 2,
      apiMs: 5,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      rateSource: "fixture",
      rateCheckedAt: null,
      costUsd: 0.000014,
    };
    await recorder.addAttemptCalls([classification]);
    await recorder.addStep(step("retry-failed", "failed"));
    await recorder.finishTest("failed");
    await recorder.startAttempt();
    await recorder.addAttemptCalls([classification]);
    await recorder.addStep(step("retry-passed", "passed"));
    await recorder.finishTest("passed");
    await recorder.finish();
    expect(recorder.snapshot).toMatchObject({
      verdict: "passed",
      totals: {
        passedTests: 1,
        failedTests: 0,
        passedSteps: 1,
        failedSteps: 0,
        historicalAttempts: 1,
        modelCalls: 2,
        costUsd: 0.000028,
      },
    });
    expect(
      recorder.snapshot.tests[0]?.attempts.map((attempt) => attempt.verdict),
    ).toEqual(["failed", "passed"]);
    expect(
      recorder.snapshot.tests[0]?.attempts.map(
        (attempt) => attempt.calls?.length,
      ),
    ).toEqual([1, 1]);
  });

  it("rejects contradictory totals, duplicate IDs and zero-test completion", async () => {
    const recorder = new RunRecorder(async () => {}, "run-2");
    await recorder.start();
    await recorder.finish();
    expect(recorder.snapshot).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "no_tests" },
    });
    expect(() =>
      validateRunResult({
        ...recorder.snapshot,
        state: "completed",
        error: null,
      }),
    ).toThrow();
    expect(() =>
      validateRunResult({
        ...recorder.snapshot,
        totals: { ...recorder.snapshot.totals, modelCalls: 7 },
      }),
    ).toThrow();
  });

  it("keeps attempt IDs distinct from user-chosen test IDs", async () => {
    const recorder = new RunRecorder(async () => {}, "collision-run");
    await recorder.start();
    await recorder.startTest({ id: "foo", file: "foo.test.yaml" });
    await recorder.finishTest("passed");
    await recorder.startTest({
      id: "foo:attempt:1",
      file: "other.test.yaml",
    });
    await recorder.finishTest("passed");
    await recorder.finish();
    const result = recorder.snapshot;
    expect(result.tests.map((test) => test.id)).toEqual([
      "foo",
      "foo:attempt:1",
    ]);
    expect(
      new Set(
        result.tests.flatMap((test) =>
          test.attempts.map((attempt) => attempt.id),
        ),
      ).size,
    ).toBe(2);
    expect(validateRunResult(result).verdict).toBe("passed");
  });

  it("rejects broken problem order, links, and primary outcome", async () => {
    const recorder = new RunRecorder(async () => {}, "problem-run");
    await recorder.start();
    await recorder.startTest({ id: "problem-test", file: "cart.test.yaml" });
    await recorder.addStep(step("problem-step", "failed"));
    await recorder.finishTest("failed");
    await recorder.finish();
    const result = recorder.snapshot;
    const attempt = result.tests[0]!.attempts[0]!;
    const problem = attempt.problems[0]!;
    expect(problem).toMatchObject({
      origin: "step",
      outcome: "failed",
      stepId: "problem-step",
      ordinal: 1,
    });
    const changed = (overrides: Partial<typeof attempt>) => ({
      ...result,
      tests: [
        {
          ...result.tests[0]!,
          attempts: [{ ...attempt, ...overrides }],
        },
      ],
    });
    expect(() =>
      validateRunResult(changed({ problems: [{ ...problem, ordinal: 2 }] })),
    ).toThrow("Problem ordinals");
    expect(() =>
      validateRunResult(
        changed({ problems: [{ ...problem, stepId: "missing" }] }),
      ),
    ).toThrow("Problem step link");
    expect(() =>
      validateRunResult(changed({ primaryProblemId: null })),
    ).toThrow("first problem");
    expect(() =>
      validateRunResult(
        changed({ problems: [{ ...problem, outcome: "error" }] }),
      ),
    ).toThrow("Problem disagrees");
  });

  it("preserves asymmetric run boundaries and top-level diagnostic order", async () => {
    const valid = await recordedResult();
    valid.execution = {
      parallel: { requested: "auto", lanes: 1 },
      shard: { index: 2, count: 2, globalSelectedTests: 1 },
      providerConcurrency: 1,
    };
    expect(validateRunResult(valid)).toEqual(valid);

    const invalidShard = copyResult(valid);
    invalidShard.execution!.shard!.index = 3;
    invalidShard.selectedTestCount = 0;
    expectDiagnostic(invalidShard, "Shard index exceeds shard count");

    const selected = copyResult(valid);
    selected.selectedTestCount = 0;
    expectDiagnostic(
      selected,
      "Selected test count is smaller than started tests",
    );

    const discovery = copyResult(valid);
    discovery.discoveryProblems = [
      { file: "bad.test.yaml", code: "invalid", message: "bad", fix: "fix" },
    ];
    discovery.tests[0]!.id = discovery.runId;
    expectDiagnostic(
      discovery,
      "Run with discovery problems cannot complete cleanly",
    );
  });

  it("preserves ID, lifecycle, and step diagnostic order", async () => {
    const valid = await recordedResult();

    const duplicateTest = copyResult(valid);
    duplicateTest.tests[0]!.id = duplicateTest.runId;
    duplicateTest.tests[0]!.verdict = null;
    expectDiagnostic(duplicateTest, `Duplicate result ID: ${valid.runId}`);

    const incompleteTest = copyResult(valid);
    incompleteTest.tests[0]!.verdict = null;
    expectDiagnostic(incompleteTest, "Completed test has incomplete attempts");

    const incompleteAttempt = copyResult(valid);
    incompleteAttempt.tests[0]!.attempts[0]!.finishedAt = null;
    expectDiagnostic(
      incompleteAttempt,
      "Completed attempt has no verdict or finish time",
    );

    const runningStep = copyResult(valid);
    runningStep.tests[0]!.attempts[0]!.steps[0]!.state = "running";
    expectDiagnostic(runningStep, "Completed attempt has a running step");

    const duplicateStep = copyResult(valid);
    duplicateStep.tests[0]!.attempts[0]!.steps[0]!.id =
      duplicateStep.tests[0]!.attempts[0]!.id;
    duplicateStep.tests[0]!.attempts[0]!.steps[0]!.kind = "measure";
    expectDiagnostic(
      duplicateStep,
      `Duplicate result ID: ${duplicateStep.tests[0]!.attempts[0]!.id}`,
    );

    const measured = copyResult(valid);
    measured.tests[0]!.attempts[0]!.steps[0]!.kind = "measure";
    expectDiagnostic(measured, "Measure step has a verdict");

    const unfinishedStep = copyResult(valid);
    unfinishedStep.tests[0]!.attempts[0]!.steps[0]!.verdict = null;
    expectDiagnostic(unfinishedStep, "Completed step has no verdict");
  });

  it("preserves problem linkage, ordering, and count diagnostics", async () => {
    const failed = await recordedResult("failed");
    const attempt = failed.tests[0]!.attempts[0]!;
    const problem = attempt.problems[0]!;

    const unexpectedPrimary = copyResult(failed);
    unexpectedPrimary.tests[0]!.attempts[0]!.problems = [];
    expectDiagnostic(
      unexpectedPrimary,
      "Problem-free attempt has a primary problem",
    );

    const wrongPrimary = copyResult(failed);
    wrongPrimary.tests[0]!.attempts[0]!.primaryProblemId = "other";
    expectDiagnostic(wrongPrimary, "The first problem must be primary");

    const ordinal = copyResult(failed);
    ordinal.tests[0]!.attempts[0]!.problems[0]!.ordinal = 2;
    expectDiagnostic(ordinal, "Problem ordinals must be consecutive");

    const missingLink = copyResult(failed);
    missingLink.tests[0]!.attempts[0]!.problems[0]!.stepId = "missing";
    expectDiagnostic(missingLink, "Problem step link is missing");

    const disagreement = copyResult(failed);
    disagreement.tests[0]!.attempts[0]!.problems[0]!.phase = "before";
    expectDiagnostic(disagreement, "Problem disagrees with linked step");

    const boundModule = copyResult(failed);
    boundModule.tests[0]!.attempts[0]!.problems[0] = {
      ...problem,
      origin: "module_binding",
    };
    expectDiagnostic(boundModule, "Module binding problem cannot link a step");

    const missingProblem = copyResult(failed);
    missingProblem.tests[0]!.attempts[0]!.problems = [];
    missingProblem.tests[0]!.attempts[0]!.primaryProblemId = null;
    expectDiagnostic(
      missingProblem,
      "Executed step problem count is inconsistent",
    );
  });

  it("preserves attempt outcome diagnostics", async () => {
    const failed = await recordedResult("failed");
    const attempt = failed.tests[0]!.attempts[0]!;
    const problem = attempt.problems[0]!;
    const failedStep = attempt.steps[0]!;

    const operationalCompletion = copyResult(failed);
    operationalCompletion.tests[0]!.attempts[0]!.problems[0] = {
      ...problem,
      outcome: "error",
    };
    operationalCompletion.tests[0]!.attempts[0]!.steps[0] = {
      ...failedStep,
      state: "error",
    };
    expectDiagnostic(
      operationalCompletion,
      "Operational primary cannot complete an attempt",
    );

    const failedWithoutProblem = await recordedResult();
    failedWithoutProblem.tests[0]!.attempts[0]!.verdict = "failed";
    expectDiagnostic(
      failedWithoutProblem,
      "Failed attempt needs a failed primary problem",
    );

    const passedWithProblem = copyResult(failed);
    passedWithProblem.tests[0]!.attempts[0]!.verdict = "passed";
    expectDiagnostic(passedWithProblem, "Passed attempt has problems");

    const errorWithFailedPrimary = copyResult(failed);
    errorWithFailedPrimary.state = "error";
    errorWithFailedPrimary.verdict = null;
    errorWithFailedPrimary.error = { code: "run_error", message: "stopped" };
    errorWithFailedPrimary.tests[0]!.state = "error";
    errorWithFailedPrimary.tests[0]!.verdict = null;
    errorWithFailedPrimary.tests[0]!.attempts[0]!.state = "error";
    errorWithFailedPrimary.tests[0]!.attempts[0]!.verdict = null;
    expectDiagnostic(
      errorWithFailedPrimary,
      "Error attempt needs an error primary problem",
    );
  });

  it("preserves selected-attempt and aggregate diagnostics", async () => {
    const valid = await recordedResult();

    const missingSelection = copyResult(valid);
    missingSelection.tests[0]!.selectedAttemptId = "missing";
    expectDiagnostic(missingSelection, "Selected attempt is missing");

    const verdict = copyResult(valid);
    verdict.tests[0]!.verdict = null;
    verdict.tests[0]!.state = "running";
    expectDiagnostic(verdict, "Test verdict differs from selected attempt");

    const flags = copyResult(valid);
    flags.tests[0]!.flags = ["flaky"];
    expectDiagnostic(flags, "Test flags differ from selected attempt");

    const totals = copyResult(valid);
    totals.totals.modelCalls += 1;
    expectDiagnostic(totals, "Run totals differ from children");

    const runVerdict = copyResult(valid);
    runVerdict.verdict = "failed";
    expectDiagnostic(runVerdict, "Run verdict differs from tests");

    const runFlags = copyResult(valid);
    runFlags.flags = ["flaky"];
    expectDiagnostic(runFlags, "Run flags differ from tests");

    const incompleteRun = copyResult(valid);
    incompleteRun.tests[0]!.state = "interrupted";
    expectDiagnostic(incompleteRun, "Completed run has no completed tests");

    const runningFinished = copyResult(valid);
    runningFinished.state = "running";
    runningFinished.verdict = null;
    expectDiagnostic(runningFinished, "Running run has finish time");

    const terminalUnfinished = copyResult(valid);
    terminalUnfinished.state = "interrupted";
    terminalUnfinished.verdict = null;
    terminalUnfinished.finishedAt = null;
    expectDiagnostic(terminalUnfinished, "Terminal run has no finish time");
  });

  propertyTest(
    "accepts shard and selected-count boundaries without changing serialization",
    async () => {
      const baseline = await recordedResult();
      hegel.test((tc) => {
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 1000 }));
        const index = tc.draw(gs.integers({ minValue: 1, maxValue: count }));
        const selectedTestCount = tc.draw(
          gs.integers({ minValue: baseline.tests.length, maxValue: 1000 }),
        );
        const candidate = copyResult(baseline);
        candidate.selectedTestCount = selectedTestCount;
        candidate.execution = {
          parallel: { requested: "auto", lanes: 1 },
          shard: { index, count, globalSelectedTests: selectedTestCount },
          providerConcurrency: 1,
        };
        refreshTotals(candidate);
        const validated = JSON.stringify(validateRunResult(candidate));
        const parsed = JSON.stringify(RunResultSchema.parse(candidate));
        if (validated !== parsed)
          throw new Error("Validation changed serialized output");
      }, propertySettings);
    },
  );
});

describe("report privacy", () => {
  propertyTest(
    "report text uses literal replacement for generated secrets",
    () => {
      hegel.test((tc) => {
        const secret = tc.draw(gs.text({ minSize: 1, maxSize: 24 }));
        const prefix = tc.draw(gs.text({ maxSize: 24 }));
        const suffix = tc.draw(gs.text({ maxSize: 24 }));
        const input = `${prefix}${secret}${suffix}`;
        const expected = input.split(secret).join("[REDACTED]");
        const redacted = safeText(input, { secretValues: [secret] }, 512);
        if (redacted !== expected)
          throw new Error("Report text did not use literal secret replacement");
      }, propertySettings);
    },
  );

  it("redacts values, strips URL secrets and bounds Unicode display", () => {
    const privacy = {
      secretValues: ["secret-123"],
      sensitiveOrigins: ["https://bank.test"],
    };
    expect(safeText("🙂secret-123🙂", privacy, 20)).toBe("🙂[REDACTED]🙂");
    expect(
      safeUrl("https://u:p@example.test/cart?token=secret-123#x", privacy),
    ).toEqual({
      url: "https://example.test/cart",
      sensitive: false,
    });
    expect(safeUrl("https://bank.test/account", privacy).sensitive).toBe(true);
    expect(Array.from(safeText("🙂".repeat(130), privacy, 120))).toHaveLength(
      120,
    );
  });
});
