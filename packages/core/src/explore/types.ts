import type { PageInspection } from "../detector/semantic.js";
import type { GoalChoice, GoalValueState } from "../goal-runner.js";
import type { ProviderCall, ProviderCallOptions } from "../provider.js";

/**
 * - random: a blind weighted random walk with fixed default weights.
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
  | {
      readonly kind: "click";
      readonly target: TargetIdentity;
      /** The option to choose when the target is a native dropdown. */
      readonly option?: string;
    }
  | {
      readonly kind: "type";
      readonly target: TargetIdentity;
      readonly value: string;
      readonly source: InputSource;
    }
  | { readonly kind: "press"; readonly key: "Enter" | "Escape" }
  | { readonly kind: "scroll"; readonly direction: "down" | "up" }
  | { readonly kind: "back" }
  | { readonly kind: "reload" }
  | { readonly kind: "wait"; readonly ms: number }
  /** Only forced, to recover; the walk never chooses it. */
  | { readonly kind: "goto"; readonly url: string };

export type ExploreActionKind = ExploreAction["kind"];

/** What the oracles watch beyond the start origin's defaults. */
export interface OracleOptions {
  /** More origins whose responses count, such as a separate API host. */
  readonly watchOrigins?: readonly string[];
  /**
   * Also report a 4xx answer to a submission (any method but GET or HEAD;
   * 401, 403 and 404 excluded): the UI let the user send something the
   * server refuses. Opt-in, since some apps rely on server-side validation.
   */
  readonly rejectedSubmits?: boolean;
  /**
   * Report a page navigation answered with HTTP 4xx or 5xx: a broken link or
   * a stale reference. On unless set to false.
   */
  readonly brokenLinks?: boolean;
  /** Console errors matching any of these regular expressions are ignored. */
  readonly ignoreConsole?: readonly string[];
  /**
   * Known findings to ignore, in the bug detector's `--detect-allow` syntax:
   * `[check:]substring` or `[check:]re:regex`.
   */
  readonly allow?: readonly string[];
}

/** A successful request that may have changed data on the server. */
export interface WriteRecord {
  readonly method: string;
  readonly endpoint: string;
  readonly status: number;
}

export interface OracleEvent {
  readonly kind:
    | "console"
    | "pageerror"
    | "rejection"
    | "http"
    | "rejected"
    | "broken-link"
    | "semantic";
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
  /** Part of a planned form fill or return path, not a fresh pick. */
  readonly planned?: boolean;
  /** Part of a return to an archived frontier page. */
  readonly restore?: boolean;
  /** Destructive candidates removed from this state's action set. */
  readonly skipped?: readonly string[];
  /** Effects planner: what Jev says the target does. */
  readonly effect?: string;
  /** Effects planner: the chosen affordance's score. */
  readonly score?: number;
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
  /** Successful non-GET requests the action caused, for side-effect audits. */
  readonly writes?: readonly WriteRecord[];
  readonly elapsedMs: number;
}

export interface ExploreFailure {
  readonly signature: string;
  readonly kind: OracleEvent["kind"];
  readonly message: string;
  /**
   * The step whose trace entry first carried the failure. A page check ran on
   * the page before that step's action; other signals came during or after it.
   */
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
  /** Ask whether each target is destructive (only with safety on). */
  readonly askDestructive?: boolean;
  /** Also ask the bug detector's page checks (`--detect semantic`). */
  readonly inspect?: boolean;
}

export interface ExploreAdvice {
  readonly kind: GoalChoice;
  /** Per target id: probability that activating it is destructive. */
  readonly destructive: Readonly<Record<string, number>>;
  /** Per target id: predicted distribution over page kinds. */
  readonly leadsTo: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The detector's page checks, when the request asked them. */
  readonly inspection?: Omit<PageInspection, "call">;
  readonly call: ProviderCall;
}

/**
 * Questions about one subject on a page, such as a form or a dropdown,
 * each answered by choosing one of its options.
 */
export interface ExploreDecisionRequest {
  /** Visible page text; untrusted data. */
  readonly page: string;
  /** The subject, as short labelled facts (untrusted). */
  readonly subject: Readonly<Record<string, string>>;
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly question: string;
        readonly rules?: string;
        /** Option id to its description (null when the id says it all). */
        readonly choices: Readonly<Record<string, string | null>>;
      }
    >
  >;
}

export interface ExploreDecision {
  readonly answers: Readonly<Record<string, GoalChoice>>;
  readonly call: ProviderCall;
}

export interface ExplorationAdvisor {
  /** One call per new page state: page kind, safety and target kinds. */
  assess(
    request: ExploreAdviceRequest,
    options?: ProviderCallOptions,
  ): Promise<ExploreAdvice>;
  /** Closed choices about one subject, asked together in one call. */
  decide?(
    request: ExploreDecisionRequest,
    options?: ProviderCallOptions,
  ): Promise<ExploreDecision>;
  /** A closed choice among Faker generators, as goal mode makes it. */
  chooseGoalValue?(
    state: GoalValueState,
    options?: ProviderCallOptions,
  ): Promise<{ readonly value: GoalChoice; readonly call: ProviderCall }>;
}

export type ExploreSafety = "off" | "on" | "strict";

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
  /** Swarm testing: drop some action kinds for this seed. */
  readonly swarm: boolean;
  /**
   * "off" (the default, for disposable staging) never skips a target except
   * one that ends the session. "on" skips what Jev judges destructive and
   * leaves settings forms alone; "strict" also skips names on the
   * destructive keyword list, even when Jev disagrees.
   */
  readonly safety: ExploreSafety;
  /** Return to rarely visited, archived pages when nothing new turns up. */
  readonly archive: boolean;
}

export const DEFAULT_TUNING: ExploreTuning = {
  epsilon: 0.2,
  skipDestructive: 0.6,
  validInput: 0.6,
  hostileInput: 0.25,
  predictTargets: true,
  swarm: false,
  safety: "off",
  archive: true,
};
