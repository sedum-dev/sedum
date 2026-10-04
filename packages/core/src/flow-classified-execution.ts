import type { ClassifiedFlowStep } from "./flow-classification.js";
import type {
  ExecutionContext,
  FlowProblem,
} from "./flow-orchestration-context.js";
import { unsupported } from "./flow-runner-support.js";
import { executeSentence } from "./flow-sentence-execution.js";
import {
  ModuleBindingResolutionError,
  resolveModuleBindings,
  type ResolvedDataEntry,
} from "./flow-values.js";
import { safeSource, safeText } from "./report-privacy.js";

function bindingFailure(error: unknown) {
  return error instanceof ModuleBindingResolutionError
    ? error
    : {
        outcome: "error" as const,
        code: "module_binding_error",
        message: "The module binding could not be resolved.",
      };
}

function failedSentence(
  context: ExecutionContext,
  item: ClassifiedFlowStep,
): FlowProblem {
  return { status: "failed", file: context.absolute, source: item.source };
}

async function sentenceProblem(
  context: ExecutionContext,
  item: Extract<ClassifiedFlowStep, { kind: "sentence" }>,
  scope: Record<string, ResolvedDataEntry>,
): Promise<FlowProblem | null> {
  const outcome = await executeSentence(
    context.page,
    item,
    context.dependencies,
    scope,
    context.opaqueEntries,
  );
  if (outcome === "failed") return failedSentence(context, item);
  if (outcome === "continue" || outcome.status === "passed") return null;
  return outcome;
}

async function reportBindingError(
  context: ExecutionContext,
  item: Extract<ClassifiedFlowStep, { kind: "module" }>,
  error: unknown,
): Promise<FlowProblem> {
  const binding = bindingFailure(error);
  const report = context.dependencies.report;
  await report?.test.addProblem({
    origin: "module_binding",
    outcome: binding.outcome,
    phase: item.phase,
    sourceStack: item.sourceStack.map((source) =>
      safeSource(source, context.dependencies.repoRoot, report.privacy),
    ),
    stepId: null,
    error: {
      code: binding.code,
      message: safeText(binding.message, report.privacy, 512),
    },
  });
  if (binding.outcome === "failed") return failedSentence(context, item);
  return {
    status: "could_not_run",
    file: context.absolute,
    code: binding.code,
    source: item.source,
    message: binding.message,
  };
}

function rememberBindings(
  context: ExecutionContext,
  local: Record<string, ResolvedDataEntry>,
): void {
  const entries = Object.values(local);
  context.dependencies.report?.privacy.secretValues.push(
    ...entries
      .filter((entry) => entry.sensitive)
      .map((entry) => entry.value.reveal()),
  );
  context.opaqueEntries.push(...entries);
}

async function moduleProblem(
  context: ExecutionContext,
  item: Extract<ClassifiedFlowStep, { kind: "module" }>,
  scope: Record<string, ResolvedDataEntry>,
  continueAfterFailure: boolean,
): Promise<FlowProblem | null> {
  if (!item.resolved)
    return unsupported(
      context.absolute,
      item.source,
      "The module graph is incomplete.",
    ) as FlowProblem;
  let local: Record<string, ResolvedDataEntry>;
  try {
    local = {
      ...resolveModuleBindings(
        item.resolved.parameters,
        item.resolved.bindings,
        scope,
        context.dependencies.env,
      ),
    };
  } catch (error) {
    return reportBindingError(context, item, error);
  }
  rememberBindings(context, local);
  return executeClassifiedItems(
    context,
    item.resolved.steps,
    local,
    continueAfterFailure,
  );
}

function itemProblem(
  context: ExecutionContext,
  item: ClassifiedFlowStep,
  scope: Record<string, ResolvedDataEntry>,
  continueAfterFailure: boolean,
): Promise<FlowProblem | null> {
  return item.kind === "sentence"
    ? sentenceProblem(context, item, scope)
    : moduleProblem(context, item, scope, continueAfterFailure);
}

/** Execute recursive classified items while retaining the first failure. */
export async function executeClassifiedItems(
  context: ExecutionContext,
  items: readonly ClassifiedFlowStep[],
  scope: Record<string, ResolvedDataEntry>,
  continueAfterFailure: boolean,
): Promise<FlowProblem | null> {
  let first: FlowProblem | null = null;
  for (const item of items) {
    const problem = await itemProblem(
      context,
      item,
      scope,
      continueAfterFailure,
    );
    if (!problem) continue;
    first ??= problem;
    if (!continueAfterFailure) return first;
  }
  return first;
}
