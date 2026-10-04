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

export interface ClassificationOptions {
  readonly mode: "offline" | "allow-model";
  readonly cache: ClassificationCache;
  readonly provider?: ClassificationProvider;
  readonly signal?: AbortSignal;
}
