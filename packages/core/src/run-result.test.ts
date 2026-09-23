import { describe, expect, it } from "vitest";
import { RunRecorder } from "./run-recorder.js";
import {
  resultTotals,
  runResultJsonSchema,
  validateRunResult,
  type ResultStep,
} from "./run-result.js";
import { safeText, safeUrl } from "./report-privacy.js";

const frame = { status: "omitted" as const, reason: "clean_step" };
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

describe("canonical RunResult", () => {
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
});

describe("report privacy", () => {
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
