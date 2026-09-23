import {
  classifySteps,
  type ClassificationCache,
  type ClassificationMetrics,
  type ClassificationProvider,
  type ClassificationResult,
  type ClassifiedStep,
} from "./classification.js";
import type { ProviderCall } from "./provider.js";
import { validateTypeOperand } from "./flow-values.js";
import type {
  FlowDefinition,
  FlowDiagnostic,
  FlowStep,
  FullValidationCoverage,
  ModuleStep,
  ParsedFlowResult,
  ResolvedModuleCall,
  SentenceStep,
} from "./flow-types.js";

export interface ClassifiedFlowSentence extends SentenceStep {
  readonly op: ClassifiedStep["op"];
  readonly classificationSource: ClassifiedStep["classificationSource"];
  readonly probability: number | null;
}
export interface ClassifiedModuleStep extends Omit<ModuleStep, "resolved"> {
  readonly resolved?: Omit<ResolvedModuleCall, "steps"> & {
    readonly steps: readonly ClassifiedFlowStep[];
  };
}
export type ClassifiedFlowStep = ClassifiedFlowSentence | ClassifiedModuleStep;
export interface ClassifiedFlowDefinition extends Omit<
  FlowDefinition,
  "before" | "steps" | "after"
> {
  readonly before: readonly ClassifiedFlowStep[];
  readonly steps: readonly ClassifiedFlowStep[];
  readonly after: readonly ClassifiedFlowStep[];
}
export interface FlowClassificationDiagnostic extends FlowDiagnostic {
  readonly sentence: string;
}
export interface FlowClassificationResult {
  readonly value?: ClassifiedFlowDefinition;
  readonly diagnostics: readonly (
    FlowDiagnostic | FlowClassificationDiagnostic
  )[];
  readonly coverage: FullValidationCoverage;
  readonly classification?: ClassificationResult;
  readonly metrics?: ClassificationMetrics;
  readonly calls: readonly ProviderCall[];
}

export interface ClassifyFlowOptions {
  readonly mode: "offline" | "allow-model";
  readonly cache: ClassificationCache;
  readonly provider?: ClassificationProvider;
  readonly signal?: AbortSignal;
}

export interface SentenceClassification {
  readonly classification: ClassificationResult;
  /** Classification and `type` operand errors, in input order. */
  readonly diagnostics: readonly FlowClassificationDiagnostic[];
}

/** Classify sentence steps and apply the post-classification `type` operand check. */
export async function classifySentenceSteps(
  sentences: readonly SentenceStep[],
  options: ClassifyFlowOptions,
): Promise<SentenceClassification> {
  const classification = await classifySteps(
    sentences.map((step) => ({ sentence: step.text, source: step.source })),
    options,
  );
  const diagnostics: FlowClassificationDiagnostic[] =
    classification.diagnostics.map((item) => ({
      severity: "error" as const,
      code: item.code,
      source: item.source,
      sentence: item.sentence,
      message: `${item.message} Sentence: ${JSON.stringify(item.sentence)}.`,
      fix: item.fix,
    }));
  sentences.forEach((step, index) => {
    if (classification.steps[index]?.op !== "type") return;
    const validated = validateTypeOperand(step);
    if ("diagnostic" in validated)
      diagnostics.push({ ...validated.diagnostic, sentence: step.text });
  });
  return { classification, diagnostics };
}

/** Compose SED-27 format parsing and SED-28 classification without executing a step. */
export async function classifyParsedFlow(
  parsed: ParsedFlowResult,
  options: ClassifyFlowOptions,
): Promise<FlowClassificationResult> {
  const flow = parsed.value ?? parsed.candidate;
  if (!flow)
    return {
      diagnostics: parsed.diagnostics,
      coverage: parsed.coverage,
      calls: [],
    };
  const collect = (steps: readonly FlowStep[]): SentenceStep[] =>
    steps.flatMap((step) =>
      step.kind === "sentence"
        ? [step]
        : step.resolved
          ? collect(step.resolved.steps)
          : [],
    );
  const sentences = collect([...flow.before, ...flow.steps, ...flow.after]);
  const checked = await classifySentenceSteps(sentences, options);
  const classification = checked.classification;
  const diagnostics: (FlowDiagnostic | FlowClassificationDiagnostic)[] = [
    ...parsed.diagnostics,
    ...checked.diagnostics,
  ];
  diagnostics.sort(
    (a, b) =>
      a.source.file.localeCompare(b.source.file) ||
      a.source.line - b.source.line ||
      a.source.col - b.source.col,
  );
  const complete =
    classification.steps.every((step) => step !== null) &&
    !diagnostics.some((item) => item.severity === "error");
  const coverage: FullValidationCoverage = {
    format: parsed.coverage.format,
    steps: complete ? "checked" : "incomplete",
    modules: parsed.coverage.modules,
  };
  if (!complete)
    return {
      diagnostics,
      coverage,
      classification,
      metrics: classification.metrics,
      calls: classification.calls,
    };
  let index = 0;
  const attach = (steps: readonly FlowStep[]): readonly ClassifiedFlowStep[] =>
    steps.map((step) => {
      if (step.kind === "module")
        return step.resolved
          ? {
              ...step,
              resolved: {
                ...step.resolved,
                steps: attach(step.resolved.steps),
              },
            }
          : (step as ClassifiedModuleStep);
      const found = classification.steps[index++]!;
      return {
        ...step,
        op: found.op,
        classificationSource: found.classificationSource,
        probability: found.probability,
      };
    });
  return {
    value: {
      ...flow,
      before: attach(flow.before),
      steps: attach(flow.steps),
      after: attach(flow.after),
    },
    diagnostics,
    coverage,
    classification,
    metrics: classification.metrics,
    calls: classification.calls,
  };
}
