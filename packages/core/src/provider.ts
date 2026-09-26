/** The SED-12 projection of one live page candidate. No DOM identity signals leave this boundary. */
export interface ResolverCandidate {
  readonly id: string;
  readonly tag: string;
  readonly role: string;
  readonly name: string;
  readonly peers: readonly string[];
  /** Where the element sits: landmark and nearest heading. */
  readonly location?: string;
  readonly editable: boolean;
  readonly disabled: boolean;
}

export type ResolverOption =
  | { readonly kind: "candidate"; readonly candidate: ResolverCandidate }
  | { readonly kind: "none"; readonly id: "none" };

/** `complete` must come from the page extraction result, not a partial batch. */
export interface ResolverCandidates {
  readonly complete: boolean;
  readonly options: readonly ResolverOption[];
}

export interface JudgePageDigest {
  readonly complete: boolean;
  readonly text: string;
  readonly error?: string;
}

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
}

export interface ProviderTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ProviderRate {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly source: string;
  readonly checkedAt: string;
}

export interface ProviderCall {
  readonly requestedModel: string;
  readonly model: string;
  readonly attempts: number;
  readonly usage: ProviderTokenUsage;
  readonly rate: ProviderRate | null;
  readonly successfulResponseCostUsd: number | null;
  /** Null when failed attempts may have consumed unreported tokens. */
  readonly totalCostUsd: number | null;
  /** True when a 429 made this call wait for a shared provider cooldown. */
  readonly rateLimited?: boolean;
  /** Milliseconds spent in shared rate-limit cooldowns. */
  readonly rateLimitWaitMs?: number;
  /** Milliseconds spent waiting for a provider concurrency slot. */
  readonly queueWaitMs?: number;
}

export interface ResolverDecision {
  readonly selection:
    | { readonly kind: "candidate"; readonly id: string }
    | { readonly kind: "none" };
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
  readonly call: ProviderCall;
}

export interface JudgeDecision {
  readonly holds: number;
  readonly contradicted: number;
  readonly call: ProviderCall;
}

export interface Resolver {
  choose(
    sentence: string,
    candidates: ResolverCandidates,
    options?: ProviderCallOptions,
  ): Promise<ResolverDecision>;
}

export interface Judge {
  holds(
    claim: string,
    pageDigest: JudgePageDigest,
    options?: ProviderCallOptions,
  ): Promise<JudgeDecision>;
}

export type ProviderErrorCode =
  | "configuration"
  | "authentication"
  | "unsupported-input"
  | "invalid-input"
  | "invalid-response"
  | "timeout"
  | "connection"
  | "retry-exhausted"
  | "rate-limited";

export class ProviderError extends Error {
  readonly failedCall?: ProviderCall;
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly attempts = 0,
    failedCall?: ProviderCall,
  ) {
    super(message);
    this.name = "ProviderError";
    if (failedCall)
      Object.defineProperty(this, "failedCall", {
        value: failedCall,
        enumerable: false,
      });
  }

  toJSON(): { code: ProviderErrorCode; message: string; attempts: number } {
    return { code: this.code, message: this.message, attempts: this.attempts };
  }
}

/** A failed request may have been billed even when usage was not returned. */
export function unknownCostCall(error: unknown): ProviderCall {
  if (error instanceof ProviderError && error.failedCall)
    return error.failedCall;
  return {
    requestedModel: "unknown",
    model: "unknown",
    attempts: error instanceof ProviderError ? Math.max(1, error.attempts) : 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    rate: null,
    successfulResponseCostUsd: null,
    totalCostUsd: null,
  };
}
