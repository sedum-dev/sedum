import { z } from "zod";
import { validateRunResultInvariants } from "./run-result/validation.js";

export { resultTotals } from "./run-result/validation.js";

const probability = z.number().finite().min(0).max(1);
const nonnegative = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
const verdict = z.enum(["passed", "failed"]);
const stepFlag = z.enum(["low_confidence", "contradiction"]);
/** Attempts, tests and runs add `flaky`: a pass that needed a retry. */
const flag = z.enum(["low_confidence", "contradiction", "flaky"]);
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
  provider: z.string().trim().min(1).max(120).optional(),
  modality: z.literal("vision").optional(),
  purpose: z.enum(["classification", "locator", "judge", "planner"]),
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
  /** Set when a 429 made this call wait for the shared provider cooldown. */
  rateLimited: z.boolean().optional(),
  /** Time spent waiting in shared rate-limit cooldowns. */
  rateLimitWaitMs: nonnegative.optional(),
  /** Time spent waiting for a provider concurrency slot. */
  queueWaitMs: nonnegative.optional(),
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
  vision: z
    .strictObject({
      outcome: z.enum(["selected", "abstained", "failed"]).optional(),
      reason: z.string().max(120).optional(),
      abstentionReason: z.string().max(120).optional(),
      elapsedMs: nonnegative,
      failure: z
        .enum([
          "timeout",
          "canceled",
          "http_error",
          "connection",
          "invalid_envelope",
          "invalid_json",
          "invalid_selection",
          "truncated_response",
          "unknown",
          "stale_page",
        ])
        .optional(),
      httpStatus: z.number().int().min(100).max(599).optional(),
    })
    .optional(),
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
  /** Enclosing `ai.group` names, outermost first; absent outside a group. */
  group: z.array(z.string().max(120)).max(16).optional(),
  /** TypeScript goal execution is planner-reported, not independently verified. */
  goal: z
    .strictObject({
      completion: z.literal("planner"),
      text: z.string(),
      actions: count,
      requests: count,
      reason: z.string(),
      dataSeed: z.number().int().optional(),
    })
    .optional(),
  sourceStack: z.array(ResultSourceSchema).min(1),
  state,
  verdict: verdict.nullable(),
  flags: z.array(stepFlag),
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
  /** Zero-based parallel lane that ran this attempt. */
  lane: count.optional(),
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
  goal: z.strictObject({ text: z.string(), verify: z.string() }).optional(),
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
export const ResultExecutionSchema = z.strictObject({
  parallel: z.strictObject({
    requested: z.union([z.number().int().positive(), z.literal("auto")]),
    lanes: z.number().int().positive(),
  }),
  shard: z
    .strictObject({
      index: z.number().int().positive(),
      count: z.number().int().positive(),
      globalSelectedTests: count,
    })
    .nullable(),
  providerConcurrency: z.number().int().positive(),
  /** Present when vision fallback is enabled; `key` is checked before tests run. */
  vision: z
    .strictObject({
      model: z.string().min(1).max(200),
      key: z.enum(["accepted", "rejected", "unreachable"]),
    })
    .optional(),
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
  execution: ResultExecutionSchema.optional(),
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
export type ResultExecution = z.infer<typeof ResultExecutionSchema>;

export function validateRunResult(value: unknown): RunResult {
  const result = RunResultSchema.parse(value);
  validateRunResultInvariants(result);
  return result;
}

export function runResultJsonSchema(): object {
  return {
    ...z.toJSONSchema(RunResultSchema, { target: "draft-2020-12" }),
    $id: "https://sedum.dev/schemas/run-result/v1",
  };
}
