import { z } from "zod";

const probability = z.number().finite().min(0).max(1);
const nonnegative = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const verdict = z.enum(["passed", "failed"]);
const flag = z.enum(["low_confidence", "contradiction"]);
const state = z.enum(["running", "completed", "interrupted", "error"]);

export const ResultSourceSchema = z.strictObject({
  file: z.string().min(1),
  line: z.number().int().positive(),
  col: z.number().int().positive(),
});
export const ResultErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().max(512),
  callLog: z.array(z.string().max(512)).max(20).optional(),
});
export const ResultPageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    observationId: z.string().min(1),
    url: z.string().max(512),
    title: z.string().max(120),
  }),
  z.strictObject({ status: z.literal("omitted"), reason: z.string().min(1) }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);
export const ResultFrameSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("captured"),
    path: z
      .string()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/),
    mediaType: z.literal("image/jpeg"),
  }),
  z.strictObject({ status: z.literal("omitted"), reason: z.string().min(1) }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.string().min(1),
  }),
]);
export const ResultCallSchema = z.strictObject({
  purpose: z.enum(["classification", "locator", "judge"]),
  requestedModel: z.string().max(120),
  model: z.string().max(120),
  attempts: count,
  inputTokens: count,
  outputTokens: count,
  apiMs: nonnegative.nullable(),
  inputUsdPerMillion: nonnegative.nullable(),
  outputUsdPerMillion: nonnegative.nullable(),
  rateSource: z.string().max(120).nullable(),
  rateCheckedAt: z.string().nullable(),
  costUsd: nonnegative.nullable(),
});
export const ResultObservationSchema = z.strictObject({
  id: z.string().min(1),
  ordinal: z.number().int().positive(),
  elapsedMs: nonnegative,
  outcome: z.enum(["accepted", "retried", "failed"]),
  reason: z.string().max(120).nullable(),
  timeoutReason: z.string().max(120).nullable(),
});
export const ResultLocatorSchema = z.strictObject({
  confidence: probability.nullable(),
  source: z.enum(["model", "cache", "none"]),
  options: z
    .array(
      z.strictObject({
        label: z.string().max(120),
        role: z.string().max(80),
        probability,
      }),
    )
    .max(5),
  cache: z
    .strictObject({
      outcome: z.enum(["hit", "miss", "bypassed"]),
      reason: z.string().max(120).nullable(),
      fallbackCalledModel: z.boolean(),
      targetChanged: z.boolean(),
    })
    .nullable(),
});
export const ResultJudgementSchema = z.strictObject({
  holds: probability,
  contradicted: probability,
  threshold: probability.nullable(),
  band: probability.nullable(),
  contradictionCutoff: probability.nullable(),
  judgedExcerpt: z.string().max(1512).nullable(),
});
export const ResultStepSchema = z.strictObject({
  id: z.string().min(1),
  index: z.number().int().positive(),
  kind: z.enum(["action", "verify", "measure"]),
  operation: z.string().max(80),
  phase: z.enum(["before", "steps", "after"]),
  sentence: z.string().max(512),
  detail: z.string().max(512),
  sourceStack: z.array(ResultSourceSchema).min(1),
  state,
  verdict: verdict.nullable(),
  flags: z.array(flag),
  elapsedMs: nonnegative,
  page: ResultPageSchema,
  locator: ResultLocatorSchema.nullable(),
  judgement: ResultJudgementSchema.nullable(),
  observations: z.array(ResultObservationSchema),
  calls: z.array(ResultCallSchema),
  error: ResultErrorSchema.nullable(),
  evidence: ResultFrameSchema,
  replayFrame: ResultFrameSchema.nullable(),
  targetBox: z
    .strictObject({
      x: probability,
      y: probability,
      width: probability,
      height: probability,
    })
    .nullable(),
});
export const ResultProblemSchema = z.strictObject({
  id: z.string().min(1),
  ordinal: z.number().int().positive(),
  origin: z.enum(["step", "module_binding"]),
  outcome: z.enum(["failed", "error"]),
  phase: z.enum(["before", "steps", "after"]),
  sourceStack: z.array(ResultSourceSchema).min(1),
  stepId: z.string().nullable(),
  error: ResultErrorSchema,
});
export const ResultAttemptSchema = z.strictObject({
  id: z.string().min(1),
  ordinal: z.number().int().positive(),
  state,
  verdict: verdict.nullable(),
  flags: z.array(flag),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  elapsedMs: nonnegative,
  timeoutReason: z.string().max(120).nullable(),
  error: ResultErrorSchema.nullable(),
  steps: z.array(ResultStepSchema),
  calls: z.array(ResultCallSchema).optional(),
  problems: z.array(ResultProblemSchema),
  primaryProblemId: z.string().nullable(),
});
export const ResultTestSchema = z.strictObject({
  id: z.string().min(1),
  file: z.string().min(1),
  description: z.string().max(512),
  tags: z.array(z.string().max(120)),
  state,
  verdict: verdict.nullable(),
  flags: z.array(flag),
  selectedAttemptId: z.string().nullable(),
  attempts: z.array(ResultAttemptSchema),
});
export const ResultTotalsSchema = z.strictObject({
  selectedTests: count,
  executedTests: count,
  passedTests: count,
  failedTests: count,
  passedSteps: count,
  failedSteps: count,
  historicalAttempts: count,
  flaggedSteps: count,
  modelCalls: count,
  inputTokens: count,
  outputTokens: count,
  costUsd: nonnegative.nullable(),
  costComplete: z.boolean(),
});
export const RunResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  state,
  verdict: verdict.nullable(),
  flags: z.array(flag),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  elapsedMs: nonnegative,
  selectedTestCount: count.optional(),
  totals: ResultTotalsSchema,
  setupCalls: z.array(ResultCallSchema),
  tests: z.array(ResultTestSchema),
  discoveryProblems: z
    .array(
      z.strictObject({
        file: z.string().max(512),
        line: z.number().int().positive().optional(),
        col: z.number().int().positive().optional(),
        code: z.string().max(120),
        message: z.string().max(512),
        fix: z.string().max(512),
      }),
    )
    .optional(),
  error: ResultErrorSchema.nullable(),
});

export type RunResult = z.infer<typeof RunResultSchema>;
export type ResultStep = z.infer<typeof ResultStepSchema>;
export type ResultTest = z.infer<typeof ResultTestSchema>;
export type ResultAttempt = z.infer<typeof ResultAttemptSchema>;
export type ResultProblem = z.infer<typeof ResultProblemSchema>;
export type ResultCall = z.infer<typeof ResultCallSchema>;
export type ResultPage = z.infer<typeof ResultPageSchema>;
export type ResultFrame = z.infer<typeof ResultFrameSchema>;

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

export function validateRunResult(value: unknown): RunResult {
  const result = RunResultSchema.parse(value);
  if (
    result.selectedTestCount !== undefined &&
    result.selectedTestCount < result.tests.length
  )
    throw new Error("Selected test count is smaller than started tests");
  if (
    result.state === "completed" &&
    (result.discoveryProblems?.length ?? 0) > 0
  )
    throw new Error("Run with discovery problems cannot complete cleanly");
  const ids = new Set<string>();
  const addId = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate result ID: ${id}`);
    ids.add(id);
  };
  addId(result.runId);
  for (const test of result.tests) {
    addId(test.id);
    if (
      test.state === "completed" &&
      (test.verdict === null ||
        test.attempts.some((attempt) => attempt.state === "running"))
    )
      throw new Error("Completed test has incomplete attempts");
    for (const attempt of test.attempts) {
      addId(attempt.id);
      if (
        attempt.state === "completed" &&
        (attempt.verdict === null || attempt.finishedAt === null)
      )
        throw new Error("Completed attempt has no verdict or finish time");
      if (
        attempt.state === "completed" &&
        attempt.steps.some((step) => step.state === "running")
      )
        throw new Error("Completed attempt has a running step");
      for (const step of attempt.steps) {
        addId(step.id);
        if (step.kind === "measure" && step.verdict !== null)
          throw new Error("Measure step has a verdict");
        if (
          step.state === "completed" &&
          step.kind !== "measure" &&
          step.verdict === null
        )
          throw new Error("Completed step has no verdict");
      }
      if (attempt.problems.length === 0 && attempt.primaryProblemId !== null)
        throw new Error("Problem-free attempt has a primary problem");
      if (
        attempt.problems.length > 0 &&
        attempt.primaryProblemId !== attempt.problems[0]?.id
      )
        throw new Error("The first problem must be primary");
      for (const [index, problem] of attempt.problems.entries()) {
        addId(problem.id);
        if (problem.ordinal !== index + 1)
          throw new Error("Problem ordinals must be consecutive");
        const linked = attempt.steps.find((step) => step.id === problem.stepId);
        if (problem.origin === "step") {
          if (!linked) throw new Error("Problem step link is missing");
          if (
            linked.phase !== problem.phase ||
            JSON.stringify(linked.sourceStack) !==
              JSON.stringify(problem.sourceStack) ||
            (problem.outcome === "failed" && linked.verdict !== "failed") ||
            (problem.outcome === "error" && linked.state !== "error")
          )
            throw new Error("Problem disagrees with linked step");
        } else if (problem.stepId !== null)
          throw new Error("Module binding problem cannot link a step");
      }
      for (const step of attempt.steps) {
        const expected =
          step.state === "error" || step.verdict === "failed" ? 1 : 0;
        const actual = attempt.problems.filter(
          (problem) => problem.origin === "step" && problem.stepId === step.id,
        ).length;
        if (actual !== expected)
          throw new Error("Executed step problem count is inconsistent");
      }
      const primary = attempt.problems[0];
      if (attempt.state === "completed" && primary?.outcome === "error")
        throw new Error("Operational primary cannot complete an attempt");
      if (
        attempt.state === "completed" &&
        attempt.verdict === "failed" &&
        primary?.outcome !== "failed"
      )
        throw new Error("Failed attempt needs a failed primary problem");
      if (
        attempt.state === "completed" &&
        attempt.verdict === "passed" &&
        attempt.problems.length > 0
      )
        throw new Error("Passed attempt has problems");
      if (
        attempt.state === "error" &&
        attempt.problems.length > 0 &&
        primary?.outcome !== "error"
      )
        throw new Error("Error attempt needs an error primary problem");
    }
    const selected = test.attempts.find(
      (attempt) => attempt.id === test.selectedAttemptId,
    );
    if (test.selectedAttemptId !== null && !selected)
      throw new Error("Selected attempt is missing");
    if (test.verdict !== (selected?.verdict ?? null))
      throw new Error("Test verdict differs from selected attempt");
    if (JSON.stringify(test.flags) !== JSON.stringify(selected?.flags ?? []))
      throw new Error("Test flags differ from selected attempt");
  }
  if (
    JSON.stringify(result.totals) !==
    JSON.stringify(
      resultTotals(
        result.tests,
        result.setupCalls,
        result.selectedTestCount ?? result.tests.length,
      ),
    )
  )
    throw new Error("Run totals differ from children");
  const finalVerdict =
    result.error || result.state !== "completed" || result.tests.length === 0
      ? null
      : result.tests.some((test) => test.verdict === "failed")
        ? "failed"
        : result.tests.every((test) => test.verdict === "passed")
          ? "passed"
          : null;
  if (result.verdict !== finalVerdict)
    throw new Error("Run verdict differs from tests");
  const runFlags = [...new Set(result.tests.flatMap((test) => test.flags))];
  if (JSON.stringify(result.flags) !== JSON.stringify(runFlags))
    throw new Error("Run flags differ from tests");
  if (
    result.state === "completed" &&
    (result.error !== null ||
      result.tests.length === 0 ||
      result.tests.some((test) => test.state !== "completed"))
  )
    throw new Error("Completed run has no completed tests");
  if (result.state === "running" && result.finishedAt !== null)
    throw new Error("Running run has finish time");
  if (result.state !== "running" && result.finishedAt === null)
    throw new Error("Terminal run has no finish time");
  return result;
}

export function runResultJsonSchema(): object {
  return {
    ...z.toJSONSchema(RunResultSchema, { target: "draft-2020-12" }),
    $id: "https://sedum.dev/schemas/run-result/v1",
  };
}
