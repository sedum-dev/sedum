import { unknownCostCall, type ProviderCall } from "../provider.js";
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
} from "./contracts.js";
import {
  WAIT_UNTIL,
  canonicalSentence,
  patternOperation,
  preflightSentence,
  validateOperand,
} from "./language.js";
import { evaluateModelAnswer, type ModelDecision } from "./model.js";

interface PendingGroup {
  readonly sentence: string;
  readonly indexes: number[];
  readonly missReason: string;
}

interface IndexedStep {
  readonly step: ClassificationInput;
  readonly index: number;
}

interface FailureRequest {
  readonly index: number;
  readonly code: ClassificationDiagnosticCode;
  readonly detail?: string;
}

interface ClassificationApplication extends IndexedStep {
  readonly op: StepOperationKind;
  readonly source: ClassifiedStep["classificationSource"];
  readonly probability: number | null;
}

interface PendingCandidate extends IndexedStep {
  readonly missReason: string;
}

interface ProviderReplyShape {
  readonly answers: readonly ModelClassification[];
  readonly calls: readonly ProviderCall[];
  readonly expectedAnswers: number;
}

interface ModelGroupResult {
  readonly group: PendingGroup;
  readonly answer: ModelClassification;
  readonly decision: ModelDecision;
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

const DEFAULT_DIAGNOSTIC_FIX =
  "Rephrase as one supported, unambiguous sentence.";
const DIAGNOSTIC_FIXES: Partial<Record<ClassificationDiagnosticCode, string>> =
  {
    multiple_actions: "Split the actions into separate steps.",
    unavailable:
      "Rephrase with an obvious supported verb, or classify online and commit the cache.",
    provider_error: "Check provider configuration and retry.",
    cache_error: "Check cache-file permissions and retry.",
    invalid_operand:
      "Use one value, address, key, or binding in the supported form.",
  };

function diagnostic(
  step: ClassificationInput,
  request: FailureRequest,
): ClassificationDiagnostic {
  return {
    ...step,
    code: request.code,
    message: request.detail ?? DIAGNOSTIC_MESSAGES[request.code],
    fix: DIAGNOSTIC_FIXES[request.code] ?? DEFAULT_DIAGNOSTIC_FIX,
  };
}

const LEXICAL_OPERATIONS = {
  type: "type",
  enter: "type",
  fill: "type",
  press: "press",
  remember: "remember",
  goto: "goto",
  wait: "wait",
  scroll: "scroll",
} as const satisfies Record<string, StepOperationKind>;
type LexicalStart = keyof typeof LEXICAL_OPERATIONS;

function lexicalOperation(sentence: string): StepOperationKind | null {
  const leading = canonicalSentence(sentence)
    .match(/^(type|enter|fill|press|remember|goto|wait|scroll)\b/iu)?.[1]
    ?.toLowerCase() as LexicalStart | undefined;
  return leading ? LEXICAL_OPERATIONS[leading] : null;
}

function lexicalOperandError(step: ClassificationInput): string | null {
  const operation = lexicalOperation(step.sentence);
  if (!operation) return null;
  if (operation === "wait" && WAIT_UNTIL.test(step.sentence)) return null;
  return validateOperand(step.sentence, operation);
}

const MODEL_DIAGNOSTICS = {
  invalid: "ambiguous",
  ambiguous: "ambiguous",
  unsupported: "unsupported",
  multiple_actions: "multiple_actions",
} as const satisfies Record<
  Exclude<ModelDecision, { accepted: true }>["reason"],
  ClassificationDiagnosticCode
>;

function modelDiagnostic(decision: Exclude<ModelDecision, { accepted: true }>) {
  return MODEL_DIAGNOSTICS[decision.reason];
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
  private readonly sourceCounts: Record<
    ClassifiedStep["classificationSource"],
    number
  > = { pattern: 0, cache: 0, model: 0 };
  private providerFailed = false;

  constructor(
    private readonly input: readonly ClassificationInput[],
    private readonly options: ClassificationOptions,
  ) {
    this.steps = Array(input.length).fill(null);
    this.failures = Array(input.length).fill(null);
  }

  async execute(): Promise<ClassificationResult> {
    this.input.forEach((step, index) => this.classifyInitial({ step, index }));
    await this.resolvePending();
    return this.result();
  }

  private fail(request: FailureRequest): void {
    this.failures[request.index] = diagnostic(
      this.input[request.index]!,
      request,
    );
  }

  private apply(application: ClassificationApplication): void {
    const operandError = validateOperand(
      application.step.sentence,
      application.op,
    );
    if (operandError) {
      this.fail({
        index: application.index,
        code: "invalid_operand",
        detail: operandError,
      });
      return;
    }
    this.steps[application.index] = {
      ...application.step,
      op: application.op,
      classificationSource: application.source,
      probability: application.probability,
    };
    this.sourceCounts[application.source]++;
  }

  private classifyInitial(item: IndexedStep): void {
    const problem = preflightSentence(item.step.sentence);
    if (problem) {
      this.fail({ index: item.index, code: problem });
      return;
    }
    const operandError = lexicalOperandError(item.step);
    if (operandError) {
      this.fail({
        index: item.index,
        code: "invalid_operand",
        detail: operandError,
      });
      return;
    }
    const op = patternOperation(item.step.sentence);
    if (op) {
      this.apply({ ...item, op, source: "pattern", probability: null });
      return;
    }
    this.readCache(item);
  }

  private readCache(item: IndexedStep): void {
    const hit = this.options.cache.get(item.step.sentence);
    let missReason = hit.reason;
    if (hit.answer) {
      const decision = evaluateModelAnswer(hit.answer);
      if (decision.accepted) {
        this.apply({
          ...item,
          op: hit.answer.op,
          source: "cache",
          probability: decision.probability,
        });
        return;
      }
      this.addMiss(decision.reason);
      missReason = decision.reason;
    } else {
      this.addMiss(hit.reason);
    }
    this.addPending({ ...item, missReason });
  }

  private addMiss(reason: string): void {
    this.misses[reason] = (this.misses[reason] ?? 0) + 1;
  }

  private addPending(candidate: PendingCandidate): void {
    const key = canonicalSentence(candidate.step.sentence);
    const group = this.pending.get(key);
    if (group) {
      group.indexes.push(candidate.index);
      return;
    }
    this.pending.set(key, {
      sentence: candidate.step.sentence,
      indexes: [candidate.index],
      missReason: candidate.missReason,
    });
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
        this.fail({
          index,
          code: "unavailable",
          detail: `Classification is unavailable offline for this sentence (cache: ${group.missReason}).`,
        });
  }

  private async classifyWithProvider(groups: readonly PendingGroup[]) {
    try {
      const reply = await this.options.provider!.classifyBatch(
        groups.map((group) => group.sentence),
        this.options.signal ? { signal: this.options.signal } : undefined,
      );
      this.validateReply({
        answers: reply.answers,
        calls: reply.calls,
        expectedAnswers: groups.length,
      });
      const decisions = reply.answers.map(evaluateModelAnswer);
      if (
        decisions.some(
          (decision) => !decision.accepted && decision.reason === "invalid",
        )
      )
        throw new Error("Invalid classification answer");
      this.calls.push(...reply.calls);
      groups.forEach((group, index) =>
        this.applyModelGroup({
          group,
          answer: reply.answers[index]!,
          decision: decisions[index]!,
        }),
      );
      await this.saveCache(groups);
    } catch (error) {
      this.handleProviderError(error, groups);
    }
  }

  private validateReply(reply: ProviderReplyShape): void {
    if (reply.answers.length !== reply.expectedAnswers)
      throw new Error("Invalid classification answer count");
    if (
      reply.calls.length === 0 ||
      reply.answers.some((answer) => !completeReceipt(answer))
    )
      throw new Error("Incomplete classification receipt");
  }

  private applyModelGroup(result: ModelGroupResult): void {
    if (!result.decision.accepted) {
      const code = modelDiagnostic(result.decision);
      for (const index of result.group.indexes) this.fail({ index, code });
      return;
    }
    for (const index of result.group.indexes)
      this.apply({
        step: this.input[index]!,
        index,
        op: result.answer.op as StepOperationKind,
        source: "model",
        probability: result.decision.probability,
      });
    if (result.group.indexes.some((index) => this.steps[index] !== null))
      this.options.cache.put(result.group.sentence, {
        op: result.answer.op as StepOperationKind,
        probabilities: result.answer.probabilities,
        model: result.answer.model,
        requestedModel: result.answer.requestedModel,
      });
  }

  private async saveCache(groups: readonly PendingGroup[]): Promise<void> {
    try {
      await this.options.cache.save();
    } catch {
      for (const group of groups)
        for (const index of group.indexes)
          this.fail({ index, code: "cache_error" });
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
      for (const index of group.indexes)
        this.fail({ index, code: "provider_error" });
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
        pattern: this.sourceCounts.pattern,
        cache: this.sourceCounts.cache,
        model: this.sourceCounts.model,
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
