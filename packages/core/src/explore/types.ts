import type { GoalChoice, GoalValueState } from "../goal-runner.js";
import type { ProviderCall, ProviderCallOptions } from "../provider.js";

/**
 * - random: a blind weighted random walk with Bombadil's default weights.
 * - heuristic: the same walk with model-free guidance (keyword safety list,
 *   untried-action bonus, type-based Faker values), as an ablation.
 * - guided: Jev decides safety, page kinds and Faker generators.
 */
export type ExploreMode = "random" | "heuristic" | "guided";

/** How a candidate is found again in a later observation or a replay. */
export interface TargetIdentity {
  readonly role: string;
  readonly name: string;
  readonly location?: string;
  /** The first peer text, such as the item a repeated button belongs to. */
  readonly peer?: string;
  /** Same-origin path and query of a link. */
  readonly href?: string;
  readonly inputType?: string;
  /** Index among candidates with the same role, name and location. */
  readonly occurrence: number;
}

export type InputSource =
  | { readonly kind: "faker"; readonly generator: string }
  | { readonly kind: "hostile" }
  | { readonly kind: "random" };

export type ExploreAction =
  | { readonly kind: "click"; readonly target: TargetIdentity }
  | {
      readonly kind: "type";
      readonly target: TargetIdentity;
      readonly value: string;
      readonly source: InputSource;
    }
  | { readonly kind: "press"; readonly key: "Enter" }
  | { readonly kind: "scroll"; readonly direction: "down" | "up" }
  | { readonly kind: "back" }
  | { readonly kind: "reload" }
  | { readonly kind: "wait"; readonly ms: number }
  /** Only forced, to recover; the walk never chooses it. */
  | { readonly kind: "goto"; readonly url: string };

export type ExploreActionKind = ExploreAction["kind"];

export interface OracleEvent {
  readonly kind: "console" | "pageerror" | "http";
  readonly message: string;
  /** Normalized message: the identity of a distinct failure. */
  readonly signature: string;
}

/** Why the walk chose an action, for the trace. */
export interface ChoiceWhy {
  readonly options: number;
  readonly probability: number;
  /** Probability that the action is destructive, when asked. */
  readonly destructive?: number;
  /** Coverage multiplier from page-kind novelty. */
  readonly novelty?: number;
  /** The kind the action is expected to lead to, observed or predicted. */
  readonly expectedKind?: string;
  /** Part of a planned form fill, not a fresh pick. */
  readonly planned?: boolean;
  /** Destructive candidates removed from this state's action set. */
  readonly skipped?: readonly string[];
}

export interface TraceEntry {
  readonly step: number;
  /** Path and query of the page the action ran on. */
  readonly route: string;
  readonly state: string;
  readonly pageKind?: string;
  readonly action: ExploreAction;
  readonly why: ChoiceWhy;
  readonly outcome: "acted" | "failed" | "forced";
  readonly error?: string;
  readonly events: readonly OracleEvent[];
  readonly elapsedMs: number;
}

export interface ExploreFailure {
  readonly signature: string;
  readonly kind: OracleEvent["kind"];
  readonly message: string;
  /** The step after which the failure was first observed. */
  readonly step: number;
}

/** One page state, as the advisor sees it. Page text is untrusted data. */
export interface ExploreAdviceRequest {
  readonly route: string;
  readonly title: string;
  readonly page: string;
  /** Click targets keyed by an opaque id. */
  readonly targets: Readonly<
    Record<
      string,
      {
        readonly role: string;
        readonly name: string;
        readonly location?: string;
        readonly href?: string;
      }
    >
  >;
  /** Page kinds offered to the classifier, with descriptions. */
  readonly kinds: Readonly<Record<string, string>>;
  /** Also predict the kind each target leads to (speculative fan-out). */
  readonly predictTargets: boolean;
}

export interface ExploreAdvice {
  readonly kind: GoalChoice;
  /** Per target id: probability that activating it is destructive. */
  readonly destructive: Readonly<Record<string, number>>;
  /** Per target id: predicted distribution over page kinds. */
  readonly leadsTo: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly call: ProviderCall;
}

export interface ExplorationAdvisor {
  /** One call per new page state: page kind, safety and target kinds. */
  assess(
    request: ExploreAdviceRequest,
    options?: ProviderCallOptions,
  ): Promise<ExploreAdvice>;
  /** A closed choice among Faker generators, as goal mode makes it. */
  chooseGoalValue?(
    state: GoalValueState,
    options?: ProviderCallOptions,
  ): Promise<{ readonly value: GoalChoice; readonly call: ProviderCall }>;
}

export interface ExploreTuning {
  /** Share of each pick drawn from the unguided weights. */
  readonly epsilon: number;
  /** Skip targets at or above this destructive probability. */
  readonly skipDestructive: number;
  /** Chance a guided fill uses a Jev-chosen Faker value. */
  readonly validInput: number;
  /** Chance a guided fill uses hostile text; the rest is blind text. */
  readonly hostileInput: number;
  readonly predictTargets: boolean;
  /** Bombadil-style swarm testing: drop some action kinds for this seed. */
  readonly swarm: boolean;
}

export const DEFAULT_TUNING: ExploreTuning = {
  epsilon: 0.2,
  skipDestructive: 0.6,
  validInput: 0.6,
  hostileInput: 0.25,
  predictTargets: true,
  swarm: false,
};
