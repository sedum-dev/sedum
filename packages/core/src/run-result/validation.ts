import type {
  ResultAttempt,
  ResultCall,
  ResultProblem,
  ResultStep,
  ResultTest,
  RunResult,
} from "../run-result.js";

export function resultTotals(
  tests: readonly ResultTest[],
  setupCalls: readonly ResultCall[] = [],
  selectedTestCount = tests.length,
): RunResult["totals"] {
  const selected = tests.flatMap((test) =>
    test.attempts.filter((attempt) => attempt.id === test.selectedAttemptId),
  );
  const steps = selected.flatMap((attempt) => attempt.steps);
  const calls = [
    ...setupCalls,
    ...tests.flatMap((test) =>
      test.attempts.flatMap((attempt) => [
        ...(attempt.calls ?? []),
        ...attempt.steps.flatMap((step) => step.calls),
      ]),
    ),
  ];
  const complete = calls.every((call) => call.costUsd !== null);
  return {
    selectedTests: selectedTestCount,
    executedTests: tests.filter((test) => test.attempts.length > 0).length,
    passedTests: tests.filter((test) => test.verdict === "passed").length,
    failedTests: tests.filter((test) => test.verdict === "failed").length,
    passedSteps: steps.filter((step) => step.verdict === "passed").length,
    failedSteps: steps.filter((step) => step.verdict === "failed").length,
    historicalAttempts: tests.reduce(
      (sum, test) => sum + Math.max(0, test.attempts.length - 1),
      0,
    ),
    flaggedSteps: steps.filter((step) => step.flags.length > 0).length,
    modelCalls: calls.reduce((sum, call) => sum + call.attempts, 0),
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    costUsd: complete
      ? calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0)
      : null,
    costComplete: complete,
  };
}

function rejectIf(condition: boolean, message: string): void {
  if (condition) throw new Error(message);
}

class ResultIds {
  private readonly values = new Set<string>();

  add(id: string): void {
    rejectIf(this.values.has(id), `Duplicate result ID: ${id}`);
    this.values.add(id);
  }
}

function validateRunSetup(result: RunResult): void {
  const shard = result.execution?.shard;
  rejectIf(
    shard !== null && shard !== undefined && shard.index > shard.count,
    "Shard index exceeds shard count",
  );
  rejectIf(
    result.selectedTestCount !== undefined &&
      result.selectedTestCount < result.tests.length,
    "Selected test count is smaller than started tests",
  );
  rejectIf(
    result.state === "completed" && (result.discoveryProblems?.length ?? 0) > 0,
    "Run with discovery problems cannot complete cleanly",
  );
}

function validateCompletedTest(test: ResultTest): void {
  if (test.state !== "completed") return;
  const hasIncompleteAttempt = test.attempts.some(
    (attempt) => attempt.state === "running",
  );
  rejectIf(
    test.verdict === null || hasIncompleteAttempt,
    "Completed test has incomplete attempts",
  );
}

function validateCompletedAttempt(attempt: ResultAttempt): void {
  if (attempt.state !== "completed") return;
  rejectIf(
    attempt.verdict === null || attempt.finishedAt === null,
    "Completed attempt has no verdict or finish time",
  );
  const hasRunningStep = attempt.steps.some((step) => step.state === "running");
  rejectIf(hasRunningStep, "Completed attempt has a running step");
}

function validateStep(step: ResultStep, ids: ResultIds): void {
  ids.add(step.id);
  rejectIf(
    step.kind === "measure" && step.verdict !== null,
    "Measure step has a verdict",
  );
  rejectIf(
    step.state === "completed" &&
      step.kind !== "measure" &&
      step.verdict === null,
    "Completed step has no verdict",
  );
}

function validateProblemSelection(attempt: ResultAttempt): void {
  rejectIf(
    attempt.problems.length === 0 && attempt.primaryProblemId !== null,
    "Problem-free attempt has a primary problem",
  );
  rejectIf(
    attempt.problems.length > 0 &&
      attempt.primaryProblemId !== attempt.problems[0]?.id,
    "The first problem must be primary",
  );
}

function problemDisagrees(problem: ResultProblem, step: ResultStep): boolean {
  if (step.phase !== problem.phase) return true;
  if (JSON.stringify(step.sourceStack) !== JSON.stringify(problem.sourceStack))
    return true;
  if (problem.outcome === "failed" && step.verdict !== "failed") return true;
  return problem.outcome === "error" && step.state !== "error";
}

function validateProblem(
  problem: ResultProblem,
  index: number,
  attempt: ResultAttempt,
  ids: ResultIds,
): void {
  ids.add(problem.id);
  rejectIf(
    problem.ordinal !== index + 1,
    "Problem ordinals must be consecutive",
  );
  const linked = attempt.steps.find((step) => step.id === problem.stepId);
  if (problem.origin === "step") {
    rejectIf(!linked, "Problem step link is missing");
    rejectIf(
      problemDisagrees(problem, linked!),
      "Problem disagrees with linked step",
    );
    return;
  }
  rejectIf(
    problem.stepId !== null,
    "Module binding problem cannot link a step",
  );
}

function validateStepProblemCount(
  step: ResultStep,
  problems: readonly ResultProblem[],
): void {
  const expected = step.state === "error" || step.verdict === "failed" ? 1 : 0;
  const actual = problems.filter(
    (problem) => problem.origin === "step" && problem.stepId === step.id,
  ).length;
  rejectIf(actual !== expected, "Executed step problem count is inconsistent");
}

function validateCompletedAttemptOutcome(attempt: ResultAttempt): void {
  if (attempt.state !== "completed") return;
  const primary = attempt.problems[0];
  rejectIf(
    primary?.outcome === "error",
    "Operational primary cannot complete an attempt",
  );
  rejectIf(
    attempt.verdict === "failed" && primary?.outcome !== "failed",
    "Failed attempt needs a failed primary problem",
  );
  rejectIf(
    attempt.verdict === "passed" && attempt.problems.length > 0,
    "Passed attempt has problems",
  );
}

function validateErrorAttemptOutcome(attempt: ResultAttempt): void {
  const primary = attempt.problems[0];
  rejectIf(
    attempt.state === "error" &&
      attempt.problems.length > 0 &&
      primary?.outcome !== "error",
    "Error attempt needs an error primary problem",
  );
}

function validateAttempt(attempt: ResultAttempt, ids: ResultIds): void {
  ids.add(attempt.id);
  validateCompletedAttempt(attempt);
  for (const step of attempt.steps) validateStep(step, ids);
  validateProblemSelection(attempt);
  for (const [index, problem] of attempt.problems.entries())
    validateProblem(problem, index, attempt, ids);
  for (const step of attempt.steps)
    validateStepProblemCount(step, attempt.problems);
  validateCompletedAttemptOutcome(attempt);
  validateErrorAttemptOutcome(attempt);
}

function validateSelectedAttempt(test: ResultTest): void {
  const selected = test.attempts.find(
    (attempt) => attempt.id === test.selectedAttemptId,
  );
  rejectIf(
    test.selectedAttemptId !== null && !selected,
    "Selected attempt is missing",
  );
  rejectIf(
    test.verdict !== (selected?.verdict ?? null),
    "Test verdict differs from selected attempt",
  );
  rejectIf(
    JSON.stringify(test.flags) !== JSON.stringify(selected?.flags ?? []),
    "Test flags differ from selected attempt",
  );
}

function validateTest(test: ResultTest, ids: ResultIds): void {
  ids.add(test.id);
  validateCompletedTest(test);
  for (const attempt of test.attempts) validateAttempt(attempt, ids);
  validateSelectedAttempt(test);
}

function expectedRunVerdict(result: RunResult): RunResult["verdict"] {
  if (result.error || result.state !== "completed" || result.tests.length === 0)
    return null;
  if (result.tests.some((test) => test.verdict === "failed")) return "failed";
  if (result.tests.every((test) => test.verdict === "passed")) return "passed";
  return null;
}

function validateRunAggregates(result: RunResult): void {
  const expectedTotals = resultTotals(
    result.tests,
    result.setupCalls,
    result.selectedTestCount ?? result.tests.length,
  );
  rejectIf(
    JSON.stringify(result.totals) !== JSON.stringify(expectedTotals),
    "Run totals differ from children",
  );
  rejectIf(
    result.verdict !== expectedRunVerdict(result),
    "Run verdict differs from tests",
  );
  const runFlags = [...new Set(result.tests.flatMap((test) => test.flags))];
  rejectIf(
    JSON.stringify(result.flags) !== JSON.stringify(runFlags),
    "Run flags differ from tests",
  );
}

function validateRunCompletion(result: RunResult): void {
  const hasIncompleteTest = result.tests.some(
    (test) => test.state !== "completed",
  );
  rejectIf(
    result.state === "completed" &&
      (result.error !== null || result.tests.length === 0 || hasIncompleteTest),
    "Completed run has no completed tests",
  );
  rejectIf(
    result.state === "running" && result.finishedAt !== null,
    "Running run has finish time",
  );
  rejectIf(
    result.state !== "running" && result.finishedAt === null,
    "Terminal run has no finish time",
  );
}

export function validateRunResultInvariants(result: RunResult): void {
  validateRunSetup(result);
  const ids = new ResultIds();
  ids.add(result.runId);
  for (const test of result.tests) validateTest(test, ids);
  validateRunAggregates(result);
  validateRunCompletion(result);
}
