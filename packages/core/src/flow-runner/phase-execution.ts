import { executeClassifiedItems } from "./classified-execution.js";
import { executeFlowGoal } from "./goal-execution.js";
import type { ExecutionContext, FlowProblem } from "./orchestration-context.js";
import type { FlowRunResult } from "./contracts.js";

async function bodyProblem(
  context: ExecutionContext,
): Promise<FlowProblem | null> {
  const goal = context.flow.goal;
  return goal
    ? executeFlowGoal(context, goal)
    : executeClassifiedItems(context, context.flow.steps, context.data, false);
}

function goalFailureIsNotRetryable(
  context: ExecutionContext,
  problem: FlowProblem,
): FlowProblem {
  return context.flow.goal && problem.status === "failed"
    ? { ...problem, retryable: false }
    : problem;
}

async function finish(
  context: ExecutionContext,
  problem: FlowProblem | null,
): Promise<FlowRunResult> {
  if (!problem) {
    await context.dependencies.report?.test.finishTest("passed");
    return { status: "passed", file: context.absolute };
  }
  if (problem.status === "failed")
    await context.dependencies.report?.test.finishTest("failed");
  return goalFailureIsNotRetryable(context, problem);
}

/** Select setup, body, then teardown's first primary outcome. */
export async function executeFlowPhases(
  context: ExecutionContext,
): Promise<FlowRunResult> {
  const setup = await executeClassifiedItems(
    context,
    context.flow.before,
    context.data,
    false,
  );
  const body = setup ? null : await bodyProblem(context);
  const teardown = context.page.closed
    ? null
    : await executeClassifiedItems(
        context,
        context.flow.after,
        context.data,
        true,
      );
  return finish(context, setup ?? body ?? teardown);
}
