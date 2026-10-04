import { unknownCostCall, type ProviderCall } from "./provider.js";
import {
  ClassificationBatchError,
  type ClassificationDiagnostic,
  type ClassificationDiagnosticCode,
  type ClassificationInput,
  type ClassificationOptions,
  type ClassificationResult,
  type ClassifiedStep,
  type ModelClassification,
  type StepOperationKind,
} from "./classification-contracts.js";
import {
  WAIT_UNTIL,
  canonicalSentence,
  patternOperation,
  preflightSentence,
  validateOperand,
} from "./classification-language.js";
import {
  evaluateModelAnswer,
  type ModelDecision,
} from "./classification-model.js";

interface PendingGroup {
  readonly sentence: string;
  readonly indexes: number[];
  readonly missReason: string;
}

const DIAGNOSTIC_MESSAGES = {
  empty: "The step is empty.",
  unsupported: "The sentence asks for an unsupported or unclear operation.",
  multiple_actions: "The sentence asks for more than one action.",
  invalid_operand: "The operation does not have one valid operand.",
  unavailable: "Classification is unavailable offline for this sentence.",
  ambiguous: "The model could not classify this sentence unambiguously.",
  provider_error: "Classification provider could not complete this file.",
  cache_error: "The classification cache could not be saved.",
} as const;

function diagnosticFix(code: ClassificationDiagnosticCode): string {
  switch (code) {
    case "multiple_actions":
      return "Split the actions into separate steps.";
    case "unavailable":
      return "Rephrase with an obvious supported verb, or classify online and commit the cache.";
    case "provider_error":
      return "Check provider configuration and retry.";
    case "cache_error":
      return "Check cache-file permissions and retry.";
    case "invalid_operand":
      return "Use one value, address, key, or binding in the supported form.";
    default:
      return "Rephrase as one supported, unambiguous sentence.";
  }
}

function diagnostic(
  step: ClassificationInput,
  code: ClassificationDiagnosticCode,
  detail?: string,
): ClassificationDiagnostic {
  return {
    ...step,
    code,
    message: detail ?? DIAGNOSTIC_MESSAGES[code],
    fix: diagnosticFix(code),
  };
}

function lexicalOperation(sentence: string): StepOperationKind | null {
  const leading = canonicalSentence(sentence)
    .match(/^(type|enter|fill|press|remember|goto|wait|scroll)\b/iu)?.[1]
    ?.toLowerCase();
  if (leading === "type" || leading === "enter" || leading === "fill")
    return "type";
  if (
    leading === "press" ||
    leading === "remember" ||
    leading === "goto" ||
    leading === "wait" ||
    leading === "scroll"
  )
    return leading;
  return null;
}

function modelDiagnostic(decision: Exclude<ModelDecision, { accepted: true }>) {
  if (decision.reason === "multiple_actions") return "multiple_actions";
  if (decision.reason === "unsupported") return "unsupported";
  return "ambiguous";
}

function completeReceipt(answer: ModelClassification | undefined): boolean {
  return Boolean(
    answer &&
    typeof answer.model === "string" &&
    answer.model &&
    typeof answer.requestedModel === "string" &&
    answer.requestedModel,
  );
}

class ClassificationRun {
  private readonly started = performance.now();
  private readonly steps: (ClassifiedStep | null)[];
  private readonly failures: (ClassificationDiagnostic | null)[];
  private readonly misses = Object.create(null) as Record<string, number>;
  private readonly pending = new Map<string, PendingGroup>();
  private readonly calls: ProviderCall[] = [];
  private pattern = 0;
  private cache = 0;
  private model = 0;
  private providerFailed = false;

  constructor(
    private readonly input: readonly ClassificationInput[],
    private readonly options: ClassificationOptions,
  ) {
    this.steps = Array(input.length).fill(null);
    this.failures = Array(input.length).fill(null);
  }

  async execute(): Promise<ClassificationResult> {
    this.input.forEach((step, index) => this.classifyInitial(step, index));
    await this.resolvePending();
    return this.result();
  }

  private fail(
    index: number,
    code: ClassificationDiagnosticCode,
    detail?: string,
  ): void {
    this.failures[index] = diagnostic(this.input[index]!, code, detail);
  }

  private apply(
    index: number,
    op: StepOperationKind,
    source: ClassifiedStep["classificationSource"],
    probability: number | null,
  ): void {
    const step = this.input[index]!;
    const operandError = validateOperand(step.sentence, op);
    if (operandError) {
      this.fail(index, "invalid_operand", operandError);
      return;
    }
    this.steps[index] = {
      ...step,
      op,
      classificationSource: source,
      probability,
    };
    this.incrementSource(source);
  }

  private incrementSource(
    source: ClassifiedStep["classificationSource"],
  ): void {
    if (source === "pattern") this.pattern++;
    else if (source === "cache") this.cache++;
    else this.model++;
  }

  private classifyInitial(step: ClassificationInput, index: number): void {
    const problem = preflightSentence(step.sentence);
    if (problem) {
      this.fail(index, problem);
      return;
    }
    const lexicalOp = lexicalOperation(step.sentence);
    if (
      lexicalOp &&
      !(lexicalOp === "wait" && WAIT_UNTIL.test(step.sentence))
    ) {
      const operandError = validateOperand(step.sentence, lexicalOp);
      if (operandError) {
        this.fail(index, "invalid_operand", operandError);
        return;
      }
    }
    const op = patternOperation(step.sentence);
    if (op) {
      this.apply(index, op, "pattern", null);
      return;
    }
    this.readCache(step, index);
  }

  private readCache(step: ClassificationInput, index: number): void {
    const hit = this.options.cache.get(step.sentence);
    let missReason = hit.reason;
    if (hit.answer) {
      const decision = evaluateModelAnswer(hit.answer);
      if (decision.accepted) {
        this.apply(index, hit.answer.op, "cache", decision.probability);
        return;
      }
      this.addMiss(decision.reason);
      missReason = decision.reason;
    } else {
      this.addMiss(hit.reason);
    }
    this.addPending(step.sentence, index, missReason);
  }

  private addMiss(reason: string): void {
    this.misses[reason] = (this.misses[reason] ?? 0) + 1;
  }

  private addPending(
    sentence: string,
    index: number,
    missReason: string,
  ): void {
    const key = canonicalSentence(sentence);
    const group = this.pending.get(key);
    if (group) {
      group.indexes.push(index);
      return;
    }
    this.pending.set(key, { sentence, indexes: [index], missReason });
  }

  private async resolvePending(): Promise<void> {
    if (this.pending.size === 0) return;
    const groups = [...this.pending.values()];
    if (this.options.mode === "offline" || !this.options.provider) {
      this.rejectOffline(groups);
      return;
    }
    await this.classifyWithProvider(groups);
  }

  private rejectOffline(groups: readonly PendingGroup[]): void {
    for (const group of groups)
      for (const index of group.indexes)
        this.fail(
          index,
          "unavailable",
          `Classification is unavailable offline for this sentence (cache: ${group.missReason}).`,
        );
  }

  private async classifyWithProvider(groups: readonly PendingGroup[]) {
    try {
      const reply = await this.options.provider!.classifyBatch(
        groups.map((group) => group.sentence),
        this.options.signal ? { signal: this.options.signal } : undefined,
      );
      this.validateReply(reply.answers, reply.calls, groups.length);
      const decisions = reply.answers.map(evaluateModelAnswer);
      if (
        decisions.some(
          (decision) => !decision.accepted && decision.reason === "invalid",
        )
      )
        throw new Error("Invalid classification answer");
      this.calls.push(...reply.calls);
      groups.forEach((group, index) =>
        this.applyModelGroup(group, reply.answers[index]!, decisions[index]!),
      );
      await this.saveCache(groups);
    } catch (error) {
      this.handleProviderError(error, groups);
    }
  }

  private validateReply(
    answers: readonly ModelClassification[],
    calls: readonly ProviderCall[],
    expectedAnswers: number,
  ): void {
    if (answers.length !== expectedAnswers)
      throw new Error("Invalid classification answer count");
    if (
      calls.length === 0 ||
      answers.some((answer) => !completeReceipt(answer))
    )
      throw new Error("Incomplete classification receipt");
  }

  private applyModelGroup(
    group: PendingGroup,
    answer: ModelClassification,
    decision: ModelDecision,
  ): void {
    if (!decision.accepted) {
      const code = modelDiagnostic(decision);
      for (const index of group.indexes) this.fail(index, code);
      return;
    }
    for (const index of group.indexes)
      this.apply(
        index,
        answer.op as StepOperationKind,
        "model",
        decision.probability,
      );
    if (group.indexes.some((index) => this.steps[index] !== null))
      this.options.cache.put(group.sentence, {
        op: answer.op as StepOperationKind,
        probabilities: answer.probabilities,
        model: answer.model,
        requestedModel: answer.requestedModel,
      });
  }

  private async saveCache(groups: readonly PendingGroup[]): Promise<void> {
    try {
      await this.options.cache.save();
    } catch {
      for (const group of groups)
        for (const index of group.indexes) this.fail(index, "cache_error");
    }
  }

  private handleProviderError(
    error: unknown,
    groups: readonly PendingGroup[],
  ): void {
    this.providerFailed = true;
    if (error instanceof ClassificationBatchError) {
      this.calls.push(...error.calls);
      if (error.failedAttempts > 0)
        this.calls.push({
          ...unknownCostCall(error),
          attempts: error.failedAttempts,
        });
    } else {
      this.calls.push(unknownCostCall(error));
    }
    for (const group of groups)
      for (const index of group.indexes) this.fail(index, "provider_error");
  }

  private result(): ClassificationResult {
    const costUsd =
      this.providerFailed ||
      this.calls.some((call) => call.totalCostUsd === null)
        ? null
        : this.calls.reduce((sum, call) => sum + call.totalCostUsd!, 0);
    return {
      steps: this.steps,
      diagnostics: this.failures.filter(
        (failure): failure is ClassificationDiagnostic => failure !== null,
      ),
      calls: this.calls,
      metrics: {
        pattern: this.pattern,
        cache: this.cache,
        model: this.model,
        cacheMisses: this.misses,
        requests: this.calls.length,
        attempts: this.calls.reduce((sum, call) => sum + call.attempts, 0),
        inputTokens: this.calls.reduce(
          (sum, call) => sum + call.usage.inputTokens,
          0,
        ),
        outputTokens: this.calls.reduce(
          (sum, call) => sum + call.usage.outputTokens,
          0,
        ),
        costUsd,
        durationMs: performance.now() - this.started,
      },
    };
  }
}

export async function classifySteps(
  input: readonly ClassificationInput[],
  options: ClassificationOptions,
): Promise<ClassificationResult> {
  return new ClassificationRun(input, options).execute();
}
