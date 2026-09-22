import type {
  ProviderCall,
  ProviderCallOptions,
  ProviderErrorCode,
} from "./provider.js";

export const OPERATIONS = [
  "click",
  "type",
  "press",
  "goto",
  "verify",
  "measure",
  "scroll",
  "wait",
  "remember",
] as const;
export type StepOperationKind = (typeof OPERATIONS)[number];
export const MODEL_CHOICES = [
  ...OPERATIONS,
  "unsupported_or_unclear",
  "multiple_actions",
] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];
export const OPERATION_SET_VERSION = 2; // SED-10 accepted remember.
export const ACCEPTANCE_POLICY_VERSION = 1;
export const MIN_MODEL_PROBABILITY = 0.8;
export const MIN_MODEL_MARGIN = 0.15;

export interface StepSource {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly moduleStack?: readonly string[];
}
export interface ClassificationInput {
  readonly sentence: string;
  readonly source: StepSource;
}
export interface ModelClassification {
  readonly op: ModelChoice;
  readonly probabilities: Readonly<Record<ModelChoice, number>>;
  readonly model: string;
  readonly requestedModel: string;
}
export interface ClassificationProvider {
  classifyBatch(
    sentences: readonly string[],
    options?: ProviderCallOptions,
  ): Promise<{
    readonly answers: readonly ModelClassification[];
    readonly calls: readonly ProviderCall[];
  }>;
}
/** A failed file batch retains receipts for earlier billed chunks. */
export class ClassificationBatchError extends Error {
  constructor(
    readonly calls: readonly ProviderCall[],
    readonly failedAttempts: number,
    readonly code: ProviderErrorCode | null = null,
  ) {
    super("Classification provider could not complete this file.");
    this.name = "ClassificationBatchError";
  }
}
export interface CachedClassification {
  readonly op: StepOperationKind;
  readonly probabilities: Readonly<Record<ModelChoice, number>>;
  readonly model: string;
  readonly requestedModel: string;
}
export interface CacheLookup {
  readonly answer: CachedClassification | null;
  readonly reason: string;
}
export interface ClassificationCache {
  get(sentence: string): CacheLookup;
  put(sentence: string, answer: CachedClassification): void;
  save(): Promise<void>;
}
export interface ClassifiedStep extends ClassificationInput {
  readonly op: StepOperationKind;
  readonly classificationSource: "pattern" | "cache" | "model";
  /** Null for deterministic rules; model probabilities are not empirical calibration. */
  readonly probability: number | null;
}
export type ClassificationDiagnosticCode =
  | "empty"
  | "unsupported"
  | "multiple_actions"
  | "invalid_operand"
  | "unavailable"
  | "ambiguous"
  | "provider_error"
  | "cache_error";
export interface ClassificationDiagnostic extends ClassificationInput {
  readonly code: ClassificationDiagnosticCode;
  readonly message: string;
  readonly fix: string;
}
export interface ClassificationMetrics {
  readonly pattern: number;
  readonly cache: number;
  readonly model: number;
  readonly cacheMisses: Readonly<Record<string, number>>;
  readonly requests: number;
  readonly attempts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly durationMs: number;
}
export interface ClassificationResult {
  readonly steps: readonly (ClassifiedStep | null)[];
  readonly diagnostics: readonly ClassificationDiagnostic[];
  readonly calls: readonly ProviderCall[];
  readonly metrics: ClassificationMetrics;
}

const PLACEHOLDER = String.raw`\{\{\s*[A-Za-z_]\w*\s*\}\}`;
const VALUE = new RegExp(
  `^(?:type|enter|fill)\\s+(?:"[^"]*"|${PLACEHOLDER})\\s+(?:in|into)\\s+\\S`,
  "iu",
);
const VALUE_OPERAND = new RegExp(
  `("[^"]*"|${PLACEHOLDER})\\s+(?:in|into)\\s+\\S`,
  "giu",
);
const BINDING = new RegExp(`\\bas\\s+${PLACEHOLDER}\\s*\\.?$`, "iu");
const HTTP_URL = /https?:\/\/\S+/giu;
const WAIT_DURATION =
  /^wait\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\s*\.?$/iu;
const DURATION_OPERAND =
  /\b(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/giu;
const KNOWN_KEY =
  /\b(?:Enter|Tab|Escape|Esc|Space|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))\b/giu;
const SECOND_ACTION_TAIL =
  /\b(?:and|or|but|then|after|before|while|once|when|until|afterwards|subsequently|next|later|finally|followed\s+by|as\s+soon\s+as)\b\s+(.+)/iu;
const SECOND_INTERACTION =
  /\b(?:click(?:s|ed|ing)?|typ(?:e|es|ed|ing)|enter(?:s|ed|ing)?|fill(?:s|ed|ing)?|press(?:es|ed|ing)?|scroll(?:s|ed|ing)?|select(?:s|ed|ing)?|submit(?:s|ted|ting)?|tap(?:s|ped|ping)?|navigat(?:e|es|ed|ing)|go(?:es|ing)?|open(?:s|ed|ing)?|upload(?:s|ed|ing)?|download(?:s|ed|ing)?|drag(?:s|ged|ging)?|drop(?:s|ped|ping)?|log(?:s|ged|ging)?\s+in|sign(?:s|ed|ing)?\s+in)\b/iu;
const PASSIVE_INTERACTION =
  /\b(?:is|are|was|were|has|have|had)(?:\s+been)?\s+(?:clicked|typed|entered|filled|pressed|scrolled|selected|submitted|opened|uploaded|downloaded)\b/giu;
const ACTION_VERBS =
  "click|type|enter|fill|press|goto|go\\s+to|navigate|verify|assert|measure|note|observe|scroll|wait|remember|capture|record|select|tap|activate|drag|drop|upload|download|hover|swipe|double[ -]?click|right[ -]?click";

export function canonicalSentence(sentence: string): string {
  return sentence.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function withoutQuotes(sentence: string): string {
  return sentence.replace(/"[^"]*"|'[^']*'/gu, '""');
}

export function preflightSentence(
  sentence: string,
): ClassificationDiagnosticCode | null {
  const text = canonicalSentence(sentence);
  if (!text) return "empty";
  const exposed = withoutQuotes(text);
  if (
    /^(?:drag|drop|upload|download|hover|swipe|double[ -]?click|right[ -]?click)\b/iu.test(
      exposed,
    )
  )
    return "unsupported";
  // A conjunction in a claim is safe; a second imperative is not.
  if (
    new RegExp(
      `(?:\\b(?:then|and)\\s+(?:(?:also|then)\\s+)?|[;,]\\s*)(?:${ACTION_VERBS})\\b`,
      "iu",
    ).test(exposed)
  )
    return "multiple_actions";
  // Clauses can be one assertion; only a second interaction is unsafe.
  const tail = exposed.match(SECOND_ACTION_TAIL)?.[1];
  if (tail) {
    const assertion =
      /^(?:verify|assert|check|confirm|ensure|expect|measure|note|observe)\b/iu.test(
        exposed,
      );
    const activeTail = assertion ? tail.replace(PASSIVE_INTERACTION, "") : tail;
    if (SECOND_INTERACTION.test(activeTail)) return "multiple_actions";
  }
  return null;
}

export function patternOperation(sentence: string): StepOperationKind | null {
  const text = canonicalSentence(sentence);
  if (preflightSentence(text)) return null;
  if (/^remember\b/iu.test(text) && BINDING.test(text)) return "remember";
  if (/^click\s+\S/iu.test(text)) return "click";
  if (VALUE.test(text)) return "type";
  if (/^press\s+(?:the\s+)?(?:"[^"]+"|\S+)/iu.test(text)) return "press";
  if (/^(?:goto|go\s+to|navigate\s+to)\s+https?:\/\/\S+/iu.test(text))
    return "goto";
  if (/^(?:verify|assert|check|confirm|ensure|expect)\s+\S/iu.test(text))
    return "verify";
  if (/^(?:measure|note|observe)\s+\S/iu.test(text)) return "measure";
  if (/^scroll\s+(?:up|down)\b/iu.test(text)) return "scroll";
  if (WAIT_DURATION.test(text)) return "wait";
  return null;
}

/** Validate the lexical operands that cannot safely be guessed by execution. */
export function validateOperand(
  sentence: string,
  op: StepOperationKind,
): string | null {
  const text = canonicalSentence(sentence);
  if (op === "click") {
    if (!/^\S+\s+\S/iu.test(text)) return "Name one page element to click.";
  } else if (op === "type") {
    const quotedSpans = [...text.matchAll(/"[^"]*"/gu)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    const operand = [...text.matchAll(VALUE_OPERAND)].find(
      (match) =>
        !quotedSpans.some(
          (span) => match.index > span.start && match.index < span.end,
        ),
    );
    const beforeField = operand
      ? text.slice(0, operand.index + operand[1]!.length)
      : "";
    const quotes = beforeField.match(/"[^"]*"/gu) ?? [];
    const placeholders =
      beforeField
        .replace(/"[^"]*"/gu, "")
        .match(new RegExp(PLACEHOLDER, "gu")) ?? [];
    if (!operand || quotes.length + placeholders.length !== 1)
      return 'Name one value, such as {{key}} or "{{user}}@example.com", and a field.';
  } else if (op === "goto") {
    const urls = text.match(HTTP_URL) ?? [];
    if (urls.length !== 1) return "Name exactly one http(s) address.";
  } else if (op === "press") {
    const explicit =
      /^(?:press|hit|strike)\s+(?:the\s+)?(?:"[^"]+"|[\w-]+)(?:\s+key)?\s*\.?$/iu.test(
        text,
      );
    const namedKeys = [...text.matchAll(KNOWN_KEY)];
    const keyMentions = [...text.matchAll(/(?:"[^"]+"|[\w-]+)\s+key\b/giu)];
    if (!explicit && namedKeys.length !== 1 && keyMentions.length !== 1)
      return "Name exactly one key to press.";
    if (namedKeys.length > 1 || keyMentions.length > 1)
      return "Name exactly one key to press.";
  } else if (op === "remember") {
    if (!BINDING.test(text)) return "End the read with as {{a_name}}.";
    const bindings = text.match(/\bas\s+\{\{/giu) ?? [];
    if (bindings.length !== 1) return "Bind exactly one remembered value.";
  } else if (op === "wait") {
    const durations = [...text.matchAll(DURATION_OPERAND)];
    if (durations.length !== 1)
      return "Name one duration, such as wait for 2 seconds.";
    const duration = durations[0]!;
    const amount = Number(duration[1]);
    const durationMs = duration[2]!.toLowerCase().startsWith("m")
      ? amount
      : amount * 1000;
    if (durationMs <= 0 || durationMs > 30_000)
      return "Use a positive wait duration of at most 30 seconds.";
  } else if (op === "scroll") {
    if ([...text.matchAll(/\b(?:up|down)\b/giu)].length !== 1)
      return "Say scroll up or scroll down.";
  } else if (op === "verify" || op === "measure") {
    if (!/^\S+\s+\S/iu.test(text))
      return "Complete the sentence with one claim or action.";
  }
  return null;
}

export function evaluateModelAnswer(
  answer: ModelClassification | CachedClassification,
):
  | { readonly accepted: true; readonly probability: number }
  | {
      readonly accepted: false;
      readonly reason:
        "invalid" | "ambiguous" | "unsupported" | "multiple_actions";
    } {
  if (!MODEL_CHOICES.includes(answer.op as ModelChoice))
    return { accepted: false, reason: "invalid" };
  const keys = Object.keys(answer.probabilities);
  if (
    keys.length !== MODEL_CHOICES.length ||
    keys.some((key) => !MODEL_CHOICES.includes(key as ModelChoice))
  )
    return { accepted: false, reason: "invalid" };
  const values = MODEL_CHOICES.map((key) => answer.probabilities[key]);
  if (
    values.some(
      (p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1,
    )
  )
    return { accepted: false, reason: "invalid" };
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) >= 0.02) return { accepted: false, reason: "invalid" };
  const chosen = answer.probabilities[answer.op];
  const sorted = [...values].sort((a, b) => b - a);
  if (sorted[0]! - chosen > 1e-6) return { accepted: false, reason: "invalid" };
  if (answer.op === "unsupported_or_unclear")
    return { accepted: false, reason: "unsupported" };
  if (answer.op === "multiple_actions")
    return { accepted: false, reason: "multiple_actions" };
  if (chosen < MIN_MODEL_PROBABILITY || chosen - sorted[1]! < MIN_MODEL_MARGIN)
    return { accepted: false, reason: "ambiguous" };
  return { accepted: true, probability: chosen };
}

function diagnostic(
  step: ClassificationInput,
  code: ClassificationDiagnosticCode,
  detail?: string,
): ClassificationDiagnostic {
  const message =
    detail ??
    (
      {
        empty: "The step is empty.",
        unsupported:
          "The sentence asks for an unsupported or unclear operation.",
        multiple_actions: "The sentence asks for more than one action.",
        invalid_operand: "The operation does not have one valid operand.",
        unavailable: "Classification is unavailable offline for this sentence.",
        ambiguous: "The model could not classify this sentence unambiguously.",
        provider_error: "Classification provider could not complete this file.",
        cache_error: "The classification cache could not be saved.",
      } as const
    )[code];
  const fix =
    code === "multiple_actions"
      ? "Split the actions into separate steps."
      : code === "unavailable"
        ? "Rephrase with an obvious supported verb, or classify online and commit the cache."
        : code === "provider_error"
          ? "Check provider configuration and retry."
          : code === "cache_error"
            ? "Check cache-file permissions and retry."
            : code === "invalid_operand"
              ? "Use one value, address, key, or binding in the supported form."
              : "Rephrase as one supported, unambiguous sentence.";
  return { ...step, code, message, fix };
}

export async function classifySteps(
  input: readonly ClassificationInput[],
  options: {
    readonly mode: "offline" | "allow-model";
    readonly cache: ClassificationCache;
    readonly provider?: ClassificationProvider;
    readonly signal?: AbortSignal;
  },
): Promise<ClassificationResult> {
  const started = performance.now();
  const steps: (ClassifiedStep | null)[] = Array(input.length).fill(null);
  const failures: (ClassificationDiagnostic | null)[] = Array(
    input.length,
  ).fill(null);
  const fail = (
    index: number,
    code: ClassificationDiagnosticCode,
    detail?: string,
  ) => {
    failures[index] = diagnostic(input[index]!, code, detail);
  };
  const misses: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  const pending = new Map<
    string,
    { sentence: string; indexes: number[]; missReason: string }
  >();
  let pattern = 0,
    cache = 0,
    model = 0;
  const apply = (
    index: number,
    op: StepOperationKind,
    source: ClassifiedStep["classificationSource"],
    probability: number | null,
  ) => {
    const step = input[index]!;
    const operandError = validateOperand(step.sentence, op);
    if (operandError) fail(index, "invalid_operand", operandError);
    else {
      steps[index] = { ...step, op, classificationSource: source, probability };
      if (source === "pattern") pattern++;
      else if (source === "cache") cache++;
      else model++;
    }
  };
  input.forEach((step, index) => {
    const problem = preflightSentence(step.sentence);
    if (problem) {
      fail(index, problem);
      return;
    }
    const leading = canonicalSentence(step.sentence)
      .match(/^(type|enter|fill|press|remember|goto|wait|scroll)\b/iu)?.[1]
      ?.toLowerCase();
    const lexicalOp =
      leading === "type" || leading === "enter" || leading === "fill"
        ? "type"
        : leading === "press" ||
            leading === "remember" ||
            leading === "goto" ||
            leading === "wait" ||
            leading === "scroll"
          ? leading
          : null;
    if (lexicalOp) {
      const operandError = validateOperand(step.sentence, lexicalOp);
      if (operandError) {
        fail(index, "invalid_operand", operandError);
        return;
      }
    }
    const op = patternOperation(step.sentence);
    if (op) {
      apply(index, op, "pattern", null);
      return;
    }
    const hit = options.cache.get(step.sentence);
    let missReason = hit.reason;
    if (hit.answer) {
      const decision = evaluateModelAnswer(hit.answer);
      if (decision.accepted) {
        apply(index, hit.answer.op, "cache", decision.probability);
        return;
      }
      misses[decision.reason] = (misses[decision.reason] ?? 0) + 1;
      missReason = decision.reason;
    } else misses[hit.reason] = (misses[hit.reason] ?? 0) + 1;
    const key = canonicalSentence(step.sentence);
    const group = pending.get(key);
    if (group) group.indexes.push(index);
    else
      pending.set(key, {
        sentence: step.sentence,
        indexes: [index],
        missReason,
      });
  });
  const calls: ProviderCall[] = [];
  let providerFailed = false;
  let failedAttempts = 0;
  if (pending.size > 0) {
    if (options.mode === "offline" || !options.provider) {
      for (const group of pending.values())
        for (const index of group.indexes)
          fail(
            index,
            "unavailable",
            `Classification is unavailable offline for this sentence (cache: ${group.missReason}).`,
          );
    } else {
      const groups = [...pending.values()];
      try {
        const reply = await options.provider.classifyBatch(
          groups.map((g) => g.sentence),
          options.signal ? { signal: options.signal } : undefined,
        );
        if (reply.answers.length !== groups.length)
          throw new Error("Invalid classification answer count");
        if (
          reply.calls.length === 0 ||
          reply.answers.some(
            (answer) =>
              !answer ||
              typeof answer.model !== "string" ||
              !answer.model ||
              typeof answer.requestedModel !== "string" ||
              !answer.requestedModel,
          )
        )
          throw new Error("Incomplete classification receipt");
        // Validate the entire reply before allowing any cache mutation.
        const decisions = reply.answers.map(evaluateModelAnswer);
        if (decisions.some((d) => !d.accepted && d.reason === "invalid"))
          throw new Error("Invalid classification answer");
        calls.push(...reply.calls);
        groups.forEach((group, groupIndex) => {
          const answer = reply.answers[groupIndex]!;
          const decision = decisions[groupIndex]!;
          if (!decision.accepted) {
            const code =
              decision.reason === "multiple_actions"
                ? "multiple_actions"
                : decision.reason === "unsupported"
                  ? "unsupported"
                  : "ambiguous";
            for (const index of group.indexes) fail(index, code);
            return;
          }
          for (const index of group.indexes)
            apply(
              index,
              answer.op as StepOperationKind,
              "model",
              decision.probability,
            );
          if (group.indexes.some((i) => steps[i] !== null))
            options.cache.put(group.sentence, {
              op: answer.op as StepOperationKind,
              probabilities: answer.probabilities,
              model: answer.model,
              requestedModel: answer.requestedModel,
            });
        });
        try {
          await options.cache.save();
        } catch {
          for (const group of groups)
            for (const index of group.indexes) fail(index, "cache_error");
        }
      } catch (error) {
        providerFailed = true;
        if (error instanceof ClassificationBatchError) {
          calls.push(...error.calls);
          failedAttempts = error.failedAttempts;
        }
        for (const group of groups)
          for (const index of group.indexes) fail(index, "provider_error");
      }
    }
  }
  const costUsd =
    providerFailed || calls.some((c) => c.totalCostUsd === null)
      ? null
      : calls.reduce((sum, c) => sum + c.totalCostUsd!, 0);
  return {
    steps,
    diagnostics: failures.filter(
      (failure): failure is ClassificationDiagnostic => failure !== null,
    ),
    calls,
    metrics: {
      pattern,
      cache,
      model,
      cacheMisses: misses,
      requests: calls.length + (failedAttempts > 0 ? 1 : 0),
      attempts: calls.reduce((sum, c) => sum + c.attempts, 0) + failedAttempts,
      inputTokens: calls.reduce((sum, c) => sum + c.usage.inputTokens, 0),
      outputTokens: calls.reduce((sum, c) => sum + c.usage.outputTokens, 0),
      costUsd,
      durationMs: performance.now() - started,
    },
  };
}
