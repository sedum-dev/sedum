import type { Leaf } from "./actions.js";
import { looksDestructive, novelty } from "./kinds.js";
import { normalize } from "./random.js";
import type {
  ChoiceWhy,
  ExploreAdvice,
  ExploreMode,
  ExploreTuning,
} from "./types.js";

/** What the walk has learned about page kinds and where actions lead. */
export class Coverage {
  readonly visits = new Map<string, number>();
  readonly #observed = new Map<string, string>();
  readonly #tried = new Map<string, number>();

  visit(kind: string): void {
    this.visits.set(kind, (this.visits.get(kind) ?? 0) + 1);
  }

  /** Record that taking `destination` led to a page of `kind`. */
  learn(destination: string, kind: string | undefined): void {
    this.#tried.set(destination, (this.#tried.get(destination) ?? 0) + 1);
    if (kind) this.#observed.set(destination, kind);
  }

  tried(destination: string): number {
    return this.#tried.get(destination) ?? 0;
  }

  /** Distinct fields typed into on the route of a "<route> press" key. */
  typedOn(pressDestination: string): number {
    const prefix = pressDestination.replace(/ press Enter$/u, " type ");
    return [...this.#tried.keys()].filter((key) => key.startsWith(prefix))
      .length;
  }

  /** Novelty of where a click leads: observed first, then predicted. */
  expected(
    destination: string,
    predicted: Readonly<Record<string, number>> | undefined,
  ): { novelty: number; kind?: string } {
    const seen = this.#observed.get(destination);
    if (seen)
      return { novelty: novelty(this.visits.get(seen) ?? 0), kind: seen };
    if (!predicted) return { novelty: 1 };
    let expectation = 0;
    let best: [string, number] = ["", -1];
    for (const [kind, probability] of Object.entries(predicted)) {
      expectation += probability * novelty(this.visits.get(kind) ?? 0);
      if (probability > best[1]) best = [kind, probability];
    }
    return { novelty: expectation, kind: best[0] };
  }
}

export interface Guided {
  /** Final pick probabilities, aligned with the leaves. */
  readonly probabilities: readonly number[];
  readonly why: readonly Partial<ChoiceWhy>[];
  readonly skipped: readonly string[];
}

export interface GuidanceInput {
  readonly mode: ExploreMode;
  readonly leaves: readonly Leaf[];
  readonly coverage: Coverage;
  readonly tuning: ExploreTuning;
  /** The page is mainly a form (guided: by page kind), so favour typing. */
  readonly formPage?: boolean;
  /** Advice for this state, with target ids by leaf index. */
  readonly advice?: {
    readonly answer: ExploreAdvice;
    readonly ids: ReadonlyMap<number, string>;
  };
}

const UNTRIED_BONUS = 1.5;
/** Typing mass on pages whose main purpose is a form. */
const FORM_BOOST = 4;

function destructiveProbability(
  input: GuidanceInput,
  leaf: Leaf,
  index: number,
): number | undefined {
  if (leaf.kind !== "click" || !leaf.identity) return undefined;
  const id = input.advice?.ids.get(index);
  const judged =
    id === undefined ? undefined : input.advice?.answer.destructive[id];
  // Heuristic mode, and guided mode without an answer (a failed call or a
  // target past the request limit), fall back to the keyword list. Strict
  // safety uses whichever of the two is more cautious.
  return cautious(input, leaf, judged);
}

/** The judged probability, or the keyword list when there is none or when strict. */
function cautious(
  input: GuidanceInput,
  leaf: Leaf,
  judged: number | undefined,
): number {
  const keyword = looksDestructive(leaf.identity!.name) ? 1 : 0;
  if (judged === undefined) return keyword;
  return input.tuning.strictSafety ? Math.max(judged, keyword) : judged;
}

/** Guided adds Jev's part: favour destinations of rarely seen page kinds. */
function kindNovelty(
  input: GuidanceInput,
  leaf: Leaf,
  index: number,
  local: number,
): { factor: number; why: Partial<ChoiceWhy> } {
  const id = input.advice?.ids.get(index);
  const predicted =
    id === undefined ? undefined : input.advice?.answer.leadsTo[id];
  const expected = input.coverage.expected(leaf.destination!, predicted);
  return {
    factor: (local * expected.novelty) ** 2,
    why: {
      novelty: local * expected.novelty,
      ...(expected.kind ? { expectedKind: expected.kind } : {}),
    },
  };
}

function coverageFactor(
  input: GuidanceInput,
  leaf: Leaf,
  index: number,
): { factor: number; why: Partial<ChoiceWhy> } {
  if (!leaf.destination) return { factor: 1, why: {} };
  const tried = input.coverage.tried(leaf.destination);
  // Typing into the same field again is rarely new; damp repeats.
  if (leaf.kind === "type") return { factor: 1 / (1 + tried), why: {} };
  // Model-free part, shared by both modes: favour destinations not yet taken.
  const local = (tried ? 1 : UNTRIED_BONUS) * novelty(tried);
  return input.mode === "heuristic"
    ? { factor: local ** 2, why: { novelty: local } }
    : kindNovelty(input, leaf, index, local);
}

/** Category-level boosts; guidance otherwise only redistributes within a kind. */
function kindBoost(input: GuidanceInput, leaf: Leaf): number {
  if (leaf.kind === "type") return input.formPage ? FORM_BOOST : 1;
  if (leaf.kind === "press" && leaf.destination)
    return 1 + input.coverage.typedOn(leaf.destination);
  return 1;
}

/**
 * Keep Bombadil's tree shape: clicks keep their (safe) base mass and guidance
 * moves probability among them. Other kinds keep their own damping, times
 * their boost.
 */
function rescale(
  input: GuidanceInput,
  guided: readonly number[],
  safeBase: readonly number[],
): number[] {
  let clickBase = 0;
  let clickGuided = 0;
  input.leaves.forEach((leaf, index) => {
    if (leaf.kind !== "click") return;
    clickBase += safeBase[index]!;
    clickGuided += guided[index]!;
  });
  return guided.map((weight, index) => {
    const leaf = input.leaves[index]!;
    if (leaf.kind !== "click") return weight * kindBoost(input, leaf);
    return clickGuided > 0 ? (weight * clickBase) / clickGuided : 0;
  });
}

/**
 * Weight a state's leaves. Guided and heuristic modes drop likely-destructive
 * clicks, down-weight uncertain ones, favour actions leading to rarely seen
 * page kinds, then mix in `epsilon` of the blind walk over the safe leaves so
 * the walk never fully trusts the model.
 */
export function guide(input: GuidanceInput): Guided {
  const base = input.leaves.map((leaf) => leaf.base);
  if (input.mode === "random")
    return {
      probabilities: normalize(base),
      why: base.map(() => ({})),
      skipped: [],
    };
  const skipped: string[] = [];
  const why: Partial<ChoiceWhy>[] = [];
  const safeBase: number[] = [];
  const guided = input.leaves.map((leaf, index) => {
    const destructive = destructiveProbability(input, leaf, index);
    const coverage = coverageFactor(input, leaf, index);
    why.push({
      ...coverage.why,
      ...(destructive === undefined ? {} : { destructive }),
    });
    if (
      destructive !== undefined &&
      destructive >= input.tuning.skipDestructive
    ) {
      skipped.push(leaf.identity!.name);
      safeBase.push(0);
      return 0;
    }
    safeBase.push(leaf.base);
    const safety = (1 - (destructive ?? 0)) ** 2;
    return leaf.base * safety * coverage.factor;
  });
  const epsilon = input.tuning.epsilon;
  const blind = normalize(safeBase);
  const probabilities = normalize(rescale(input, guided, safeBase)).map(
    (p, index) => (1 - epsilon) * p + epsilon * blind[index]!,
  );
  return { probabilities, why, skipped };
}
