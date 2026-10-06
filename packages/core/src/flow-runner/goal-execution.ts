import {
  DEFAULT_BAND,
  DEFAULT_CONTRADICTION_CUTOFF,
  DEFAULT_MIN_P,
} from "../assertion-engine.js";
import type { ClassifiedFlowDefinition } from "../flow-classification.js";
import { recordGoalActionRequest } from "../goal-action-reporting.js";
import { goalFailureArtifacts } from "../goal-failure-reporting.js";
import { runGoal, type GoalAction, type GoalResult } from "../goal-runner.js";
import type { ExecutionContext, FlowProblem } from "./orchestration-context.js";
import { safeSource, safeText } from "../report-privacy.js";
import type { ResultCall } from "../run-result.js";
import { resultCall } from "./support.js";
import { RuntimeValue } from "../step-executor.js";

interface GoalInstrumentation {
  readonly purposes: ResultCall["purpose"][];
  reportedCalls: number;
}

type FlowGoal = NonNullable<ClassifiedFlowDefinition["goal"]>;

function visibleVerification(
  context: ExecutionContext,
  verify: string,
): string {
  return verify.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
    (placeholder, key: string) =>
      context.data[key]?.modelVisible
        ? context.data[key].value.reveal()
        : placeholder,
  );
}

function rememberGenerated(
  context: ExecutionContext,
  value: RuntimeValue,
): void {
  context.opaqueEntries.push({
    value,
    sensitive: true,
    opaqueValues: [value],
  });
  context.dependencies.report?.privacy.secretValues.push(value.reveal());
}

function planner(context: ExecutionContext, tracking: GoalInstrumentation) {
  const provider = context.dependencies.provider;
  return {
    ...(provider.targetChoiceMinOptions
      ? { targetChoiceMinOptions: provider.targetChoiceMinOptions }
      : {}),
    chooseGoal: (
      ...args: Parameters<NonNullable<typeof provider.chooseGoal>>
    ) => {
      tracking.purposes.push("planner");
      return provider.chooseGoal!(...args);
    },
    ...(provider.chooseGoalValue
      ? {
          chooseGoalValue: (
            ...args: Parameters<NonNullable<typeof provider.chooseGoalValue>>
          ) => {
            tracking.purposes.push("planner");
            return provider.chooseGoalValue!(...args);
          },
        }
      : {}),
  };
}

function judge(context: ExecutionContext, tracking: GoalInstrumentation) {
  return {
    holds: (
      ...args: Parameters<typeof context.dependencies.provider.holds>
    ) => {
      tracking.purposes.push("judge");
      return context.dependencies.provider.holds(...args);
    },
  };
}

async function goalAction(
  context: ExecutionContext,
  goal: FlowGoal,
  tracking: GoalInstrumentation,
  action: GoalAction,
): Promise<void> {
  await recordGoalActionRequest({
    page: context.page,
    action,
    report: context.dependencies.report!,
    repoRoot: context.dependencies.repoRoot,
    source: goal.source,
  });
  tracking.reportedCalls += action.calls.length;
}

async function executeGoal(
  context: ExecutionContext,
  goal: FlowGoal,
  tracking: GoalInstrumentation,
): Promise<GoalResult> {
  const dependencies = context.dependencies;
  return runGoal(
    context.page,
    planner(context, tracking),
    judge(context, tracking),
    {
      goal: goal.text,
      verify: [visibleVerification(context, goal.verify)],
      data: context.data,
      onGeneratedValue: (value) => rememberGenerated(context, value),
      ...(dependencies.report
        ? {
            onAction: (action: GoalAction) =>
              goalAction(context, goal, tracking, action),
          }
        : {}),
      ...(dependencies.verifyPolicy
        ? { verifyPolicy: dependencies.verifyPolicy }
        : {}),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    },
  );
}

function failureMessage(
  result: GoalResult,
  detail: string | undefined,
): string {
  const abstention = result.reason.endsWith("_abstention")
    ? " Name the page or control for that step in the goal, or split the goal into authored steps around it."
    : "";
  return `Goal did not pass: ${result.reason}.${detail ? ` ${detail}` : ""}${abstention}`;
}

async function reportGoal(
  context: ExecutionContext,
  goal: FlowGoal,
  result: GoalResult,
  source: FlowGoal["source"],
  tracking: GoalInstrumentation,
): Promise<void> {
  const report = context.dependencies.report;
  if (!report) return;
  const attempt = report.test.currentAttempt!;
  const id = `${attempt.id}:step:${attempt.stepCount + 1}`;
  const artifacts =
    result.status === "failed" && result.failure
      ? await goalFailureArtifacts(context.page, result, report, id)
      : undefined;
  const detail = artifacts?.detail ?? result.detail;
  const checked = result.verification[0];
  await report.test.addStep({
    id,
    index: attempt.stepCount + 1,
    kind: "verify",
    operation: "goal",
    phase: "steps",
    sentence: safeText(goal.text, report.privacy, 512),
    detail: safeText(
      `${result.actions} actions, ${result.requests} requests; ${result.reason}.${detail ? ` ${detail}` : ""} Verify: ${goal.verify}`,
      report.privacy,
      512,
    ),
    sourceStack: [
      safeSource(source, context.dependencies.repoRoot, report.privacy),
    ],
    state: "completed",
    verdict: result.status,
    flags:
      checked?.flags.filter(
        (flag): flag is "low_confidence" | "contradiction" =>
          flag === "low_confidence" || flag === "contradiction",
      ) ?? [],
    elapsedMs: result.elapsedMs,
    page: artifacts?.page ?? { status: "omitted", reason: "goal_summary" },
    locator: artifacts?.locator ?? null,
    judgement: checked
      ? {
          holds: checked.holds,
          contradicted: checked.contradicted,
          threshold: context.dependencies.verifyPolicy?.minP ?? DEFAULT_MIN_P,
          band: context.dependencies.verifyPolicy?.band ?? DEFAULT_BAND,
          contradictionCutoff:
            context.dependencies.verifyPolicy?.contradictionCutoff ??
            DEFAULT_CONTRADICTION_CUTOFF,
          judgedExcerpt: null,
        }
      : null,
    observations: [],
    calls: result.calls
      .slice(tracking.reportedCalls)
      .map((call, index) =>
        resultCall(
          call,
          tracking.purposes[index + tracking.reportedCalls] ?? "planner",
        ),
      ),
    error:
      result.status === "failed"
        ? {
            code: result.reason,
            message: safeText(
              failureMessage(result, detail),
              report.privacy,
              512,
            ),
          }
        : null,
    evidence: artifacts?.evidence ?? {
      status: "omitted",
      reason: "goal_summary",
    },
    replayFrame: null,
    targetBox: artifacts?.targetBox ?? null,
  });
}

/** Execute an autonomous goal and append its summary step. */
export async function executeFlowGoal(
  context: ExecutionContext,
  goal: FlowGoal,
): Promise<FlowProblem | null> {
  const tracking: GoalInstrumentation = { purposes: [], reportedCalls: 0 };
  const result = await executeGoal(context, goal, tracking);
  const source =
    result.reason === "verification_failed" ? goal.verifySource : goal.source;
  await reportGoal(context, goal, result, source, tracking);
  return result.status === "failed"
    ? {
        status: "failed",
        file: context.absolute,
        source,
        retryable: false,
      }
    : null;
}
