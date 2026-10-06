import type { CacheStore } from "../cache-store.js";
import type { CacheMissReason } from "../page-cache.js";
import type {
  Candidate,
  CandidatePage,
  Operation,
  PageVersion,
} from "../page-protocol.js";
import type { ProviderCall } from "../provider.js";
import type { ResolvedStepTarget } from "../step-executor.js";
import type { VisionFailure, VisionResolver } from "../vision.js";

export type LocatorFailure =
  | "none"
  | "ambiguous"
  | "stale"
  | "no_candidates"
  | "incomplete"
  | "resource_limit"
  | "not_fillable"
  | "provider_error"
  | "request_too_large"
  | "invalid_input"
  | "timeout";

export interface LocatorOptionDiagnostic {
  readonly name: string;
  readonly role: string;
  readonly probability: number;
}

export interface LocatorDiagnostic {
  readonly vision?: {
    readonly outcome?: "selected" | "abstained" | "failed";
    readonly reason?: string;
    readonly abstentionReason?: string;
    readonly elapsedMs: number;
    readonly failure?: VisionFailure | "unknown" | "stale_page";
    readonly httpStatus?: number;
  };
  readonly candidateCount: number;
  readonly rounds: number;
  readonly confidence?: number | null;
  /** Internal accepted candidate-set provenance; never projected into JSON. */
  readonly observationVersion?: PageVersion;
  /** Probabilities come only from the final comparable Choice. */
  readonly topOptions: readonly LocatorOptionDiagnostic[];
  readonly gate?: string;
}

export interface LocatorCacheDiagnostic {
  readonly outcome: "hit" | "miss" | "bypassed";
  readonly reason: CacheMissReason | null;
  readonly fallbackCalledModel: boolean;
  readonly targetChanged: boolean;
}

export interface LocatorCacheSeed {
  readonly candidate: Candidate;
  readonly eligible: CandidatePage;
  readonly key: string;
}

export type LocatorResult =
  | {
      readonly kind: "resolved";
      readonly target: ResolvedStepTarget;
      readonly diagnostic: LocatorDiagnostic;
      readonly calls: readonly ProviderCall[];
      readonly cache?: LocatorCacheDiagnostic;
      /** Internal pre-action snapshot; only the runner may stage it after success. */
      readonly cacheSeed?: LocatorCacheSeed;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: LocatorFailure;
      readonly diagnostic: LocatorDiagnostic;
      readonly calls: readonly ProviderCall[];
      readonly cache?: LocatorCacheDiagnostic;
    };

export interface RepeatedMemberPolicy {
  /** Accept any member when every member links to the same address. */
  readonly sameDestination?: boolean;
  /**
   * Accept a pick among at most three links to one address whose names are
   * the same text, or one inside the other, such as a header and a footer
   * Pricing link, when the sentence names only that text.
   */
  readonly duplicateLinks?: boolean;
  /**
   * Act on the model's pick among repeated elements with no further gate:
   * no sentence evidence, no group or member confidence, no narrowing call.
   */
  readonly modelPick?: boolean;
  /** Accept the model's pick at or above this probability and lead. */
  readonly trust?: {
    readonly minProbability: number;
    readonly minLead: number;
  };
}

export interface LocatorOptions {
  readonly visionResolver?: VisionResolver;
  readonly operation: Operation;
  readonly sentence: string;
  /** Target-only sentence for cache keys; Resolver still receives sentence. */
  readonly cacheSentence?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cache?: CacheStore;
  readonly runtimeDependent?: boolean;
  /** Redact sensitive page-derived text only at the Resolver boundary. */
  readonly projectText?: (text: string) => string;
  /**
   * Experimental: act on the model's top pick even when its probability or
   * lead is low, so the locator gives up only when the model answers none.
   */
  readonly acceptLowConfidence?: boolean;
  /**
   * When to accept the model's pick among repeated elements (same name or
   * destination) whose sentence words do not single it out. Unset acts on
   * the model's pick ({ modelPick: true }): a vague step clicks the likely
   * element, and the test author can add detail. Pass {} for the strict
   * lexical rule. For clicks with a visionResolver, unset uses the strict
   * rule before visual fallback instead. Explicit policies take precedence.
   */
  readonly repeatedMember?: RepeatedMemberPolicy;
  /**
   * When the sentence names a section ("under Most popular", "in the See
   * also box"), act on the one same-name member whose local section labels
   * hold every qualifying word. On unless set to false.
   */
  readonly sectionMatch?: boolean;
  /**
   * Show the model what a person sees that the accessible name leaves out
   * (visible text beside an aria-label, a placeholder, a logo, an icon's
   * kind). On unless set to false.
   */
  readonly nameHints?: boolean;
  /**
   * When the sentence refers to an item ("on the post about DNS") and code
   * cannot match it, ask the Resolver one yes/no question per same-name
   * member's item and act on a clear winner. Needs Resolver.verifyItems.
   * On unless set to false.
   */
  readonly verifyItems?: boolean;
  /**
   * Looser code rules for ordinals and item references (counts masked in
   * names, prepositions ignored), also applied when the model answers none.
   * On unless set to false.
   */
  readonly codeFallback?: boolean;
}
