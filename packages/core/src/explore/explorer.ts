import type { BrowserPage } from "../browser-driver.js";
import { goalGenerators } from "../goal-data.js";
import type { Aim } from "../page-protocol.js";
import type { ProviderCall } from "../provider.js";
import { actionTree, runAction, type Leaf } from "./actions.js";
import { Coverage, guide } from "./guidance.js";
import { blindValue, heuristicGenerator, hostileText } from "./inputs.js";
import { PAGE_KINDS } from "./kinds.js";
import {
  identityOf,
  observe,
  onOrigin,
  settle,
  type Observation,
} from "./observe.js";
import { Oracles } from "./oracles.js";
import { pickWeighted, SeededRandom } from "./random.js";
import {
  DEFAULT_TUNING,
  type ExplorationAdvisor,
  type ExploreAction,
  type ExploreActionKind,
  type ExploreAdvice,
  type ExploreAdviceRequest,
  type ExploreFailure,
  type ExploreMode,
  type ExploreTuning,
  type InputSource,
  type OracleEvent,
  type TargetIdentity,
  type TraceEntry,
} from "./types.js";

export interface ExploreOptions {
  readonly startUrl: string;
  readonly steps: number;
  readonly seed: number;
  readonly mode: ExploreMode;
  /** Required for guided mode and for `measureKinds`. */
  readonly advisor?: ExplorationAdvisor;
  readonly tuning?: Partial<ExploreTuning>;
  /**
   * Classify each new state with the advisor in random and heuristic modes
   * too, only to measure coverage. The answers never steer those walks.
   */
  readonly measureKinds?: boolean;
  readonly onStep?: (entry: TraceEntry) => void | Promise<void>;
  /**
   * Diagnostic capture, such as a screenshot, after a click or fill target is
   * aimed and before it is dispatched. `box` is the target as fractions (0-1) of the viewport.
   */
  readonly beforeAction?: (
    step: number,
    action: ExploreAction,
    box: Aim["box"] | null,
  ) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface ExploreResult {
  readonly seed: number;
  readonly mode: ExploreMode;
  readonly startUrl: string;
  readonly trace: readonly TraceEntry[];
  readonly failures: readonly ExploreFailure[];
  /** Distinct route-plus-text states. */
  readonly states: number;
  readonly routes: readonly string[];
  /** Visits per page kind. */
  readonly kinds: Readonly<Record<string, number>>;
  /** Distinct destructive targets the guidance refused to act on. */
  readonly skippedDestructive: readonly string[];
  /** Calls that steered the walk. */
  readonly calls: readonly ProviderCall[];
  /** Calls made only to measure coverage. */
  readonly measurementCalls: readonly ProviderCall[];
  /** Wall time of each advisor call, in milliseconds. */
  readonly advisorMs: readonly number[];
  /** Advisor failures; those states were explored unguided. */
  readonly advisorErrors: readonly string[];
  readonly excludedKinds: readonly ExploreActionKind[];
  readonly elapsedMs: number;
}

const TARGET_LIMIT = 60;
const FORM_KINDS = new Set(["form", "search", "auth"]);
const PAGE_TEXT_LIMIT = 3_000;
const SWARM_KINDS: readonly ExploreActionKind[] = [
  "type",
  "press",
  "scroll",
  "back",
  "reload",
  "wait",
];

interface StateInfo {
  readonly kind?: string;
  readonly advice?: {
    readonly answer: ExploreAdvice;
    readonly ids: ReadonlyMap<number, string>;
  };
}

/** Bombadil-style swarm testing: each run leaves out some action kinds. */
function swarmExclusions(random: SeededRandom): Set<ExploreActionKind> {
  const keep = 0.3 + random.next() * 0.5;
  return new Set(SWARM_KINDS.filter(() => random.next() >= keep));
}

function clampSteps(steps: number): number {
  const valid = Number.isSafeInteger(steps) && steps >= 1;
  if (!valid || steps > 10_000)
    throw new RangeError("Steps must be an integer from 1 to 10000");
  return steps;
}

type AdviceTarget = ExploreAdviceRequest["targets"][string];

function adviceTarget(identity: TargetIdentity): AdviceTarget {
  return {
    role: identity.role,
    name: identity.name,
    ...(identity.location ? { location: identity.location } : {}),
    ...(identity.href ? { href: identity.href } : {}),
  };
}

/** Click targets offered to the advisor, with ids by leaf index. */
function adviceTargets(observation: Observation): {
  ids: Map<number, string>;
  targets: Record<string, AdviceTarget>;
} {
  const ids = new Map<number, string>();
  const targets: Record<string, AdviceTarget> = {};
  const leaves = actionTree({
    observation,
    canGoBack: false,
    excluded: new Set(),
  });
  leaves.forEach((leaf, index) => {
    if (leaf.kind !== "click" || ids.size >= TARGET_LIMIT) return;
    const id = `t${ids.size}`;
    ids.set(index, id);
    targets[id] = adviceTarget(leaf.identity!);
  });
  return { ids, targets };
}

/** One exploration run on one page. */
class Explorer {
  readonly #random: SeededRandom;
  readonly #tuning: ExploreTuning;
  readonly #generators: ReturnType<typeof goalGenerators>;
  readonly #excluded: Set<ExploreActionKind>;
  readonly #coverage = new Coverage();
  readonly #origin: string;
  readonly #advice = new Map<string, StateInfo>();
  readonly #fieldGenerators = new Map<string, string | null>();
  readonly #trace: TraceEntry[] = [];
  readonly #failures = new Map<string, ExploreFailure>();
  readonly #states = new Set<string>();
  readonly #routes = new Set<string>();
  readonly #skipped = new Set<string>();
  readonly #calls: ProviderCall[] = [];
  readonly #measurementCalls: ProviderCall[] = [];
  readonly #advisorMs: number[] = [];
  readonly #advisorErrors: string[] = [];
  #oracles: Oracles | undefined;
  #lastKind: ExploreActionKind | undefined;
  #plan:
    | { route: string; destination: string; actions: ExploreAction[] }
    | undefined;
  #pendingDestination: string | undefined;

  constructor(
    private readonly page: BrowserPage,
    private readonly options: ExploreOptions,
  ) {
    this.#random = new SeededRandom(options.seed);
    this.#tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.#generators = goalGenerators(this.#random.fork());
    this.#excluded = this.#tuning.swarm
      ? swarmExclusions(this.#random)
      : new Set();
    this.#origin = new URL(options.startUrl).origin;
    if (options.mode === "guided" && !options.advisor)
      throw new TypeError("Guided exploration needs an advisor");
  }

  async run(): Promise<ExploreResult> {
    const started = performance.now();
    const steps = clampSteps(this.options.steps);
    await this.page.goto(this.options.startUrl);
    await settle(this.page);
    this.#oracles = new Oracles(this.page, this.#origin);
    try {
      for (let step = 0; step < steps && !this.options.signal?.aborted; step++)
        await this.#step(step).catch((error: unknown) =>
          this.#recover(step, error),
        );
    } finally {
      this.#oracles.detach();
    }
    return this.#result(performance.now() - started);
  }

  async #step(step: number): Promise<void> {
    const observation = await observe(this.page);
    this.#states.add(observation.state);
    this.#routes.add(observation.route);
    const info = await this.#stateInfo(observation);
    if (this.#pendingDestination)
      this.#coverage.learn(this.#pendingDestination, info.kind);
    if (info.kind) this.#coverage.visit(info.kind);
    if (!(await this.#continuePlan(step, observation, info)))
      await this.#choose(step, observation, info);
  }

  /** Run the next planned form action; false when no plan applies. */
  async #continuePlan(
    step: number,
    observation: Observation,
    info: StateInfo,
  ): Promise<boolean> {
    const destination = this.#plan?.destination;
    const planned = this.#planned(observation);
    if (!planned) return false;
    await this.#act(step, observation, info, planned, {
      options: 1,
      probability: 1,
      planned: true,
    });
    this.#lastKind = planned.kind;
    // Learn where the whole form fill led once its last action ran.
    this.#pendingDestination = this.#plan ? undefined : destination;
    return true;
  }

  /** Pick a fresh action from the weighted, guided tree and run it. */
  async #choose(
    step: number,
    observation: Observation,
    info: StateInfo,
  ): Promise<void> {
    const formPage = this.#formPage(observation, info);
    const leaves = actionTree({
      formPage,
      observation,
      canGoBack: await this.#canGoBack(),
      ...(this.#lastKind ? { lastKind: this.#lastKind } : {}),
      excluded: this.#excluded,
    });
    const steering = this.options.mode === "guided" && info.advice;
    const guided = guide({
      mode: this.options.mode,
      leaves,
      coverage: this.#coverage,
      tuning: this.#tuning,
      formPage,
      ...(steering ? { advice: info.advice } : {}),
    });
    guided.skipped.forEach((name) => this.#skipped.add(name));
    const index = pickWeighted(this.#random, guided.probabilities);
    const leaf = leaves[index]!;
    const action = await this.#materialize(leaf, observation);
    await this.#act(step, observation, info, action, {
      options: leaves.length,
      probability: guided.probabilities[index]!,
      ...guided.why[index],
      ...(guided.skipped.length ? { skipped: guided.skipped } : {}),
    });
    this.#lastKind = action.kind;
    this.#pendingDestination = this.#plan ? undefined : leaf.destination;
  }

  async #act(
    step: number,
    observation: Observation,
    info: StateInfo,
    action: ExploreAction,
    why: TraceEntry["why"],
  ): Promise<void> {
    const started = performance.now();
    let error: string | undefined;
    try {
      const before = this.options.beforeAction;
      await runAction(
        this.page,
        action,
        undefined,
        before ? (box) => before(step, action, box) : undefined,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      await settle(this.page);
    }
    await this.#record({
      step,
      route: observation.route,
      state: observation.state,
      ...(info.kind ? { pageKind: info.kind } : {}),
      action,
      why,
      outcome: error ? "failed" : "acted",
      ...(error ? { error } : {}),
      events: this.#oracles!.drain(),
      elapsedMs: Math.round(performance.now() - started),
    });
    await this.#enforceBoundary(step);
  }

  /** Bombadil's URL boundary: leaving the origin forces a step back. */
  async #enforceBoundary(step: number): Promise<void> {
    if (onOrigin(this.page.url, this.#origin)) return;
    const route = this.page.url;
    let action: ExploreAction = { kind: "back" };
    await runAction(this.page, action).catch(() => undefined);
    if (!onOrigin(this.page.url, this.#origin)) {
      // Record what actually brought the walk home, so replays match.
      action = { kind: "goto", url: this.options.startUrl };
      await runAction(this.page, action);
    }
    await this.#record({
      step,
      route,
      state: "outside",
      action,
      why: { options: 1, probability: 1 },
      outcome: "forced",
      events: this.#oracles!.drain(),
      elapsedMs: 0,
    });
  }

  /** A page that cannot be observed (crash, download, hang) restarts the walk. */
  async #recover(step: number, error: unknown): Promise<void> {
    if (this.options.signal?.aborted) throw error;
    const route = this.page.url;
    await this.page.goto(this.options.startUrl);
    await settle(this.page);
    this.#pendingDestination = undefined;
    await this.#record({
      step,
      route,
      state: "unobservable",
      action: { kind: "goto", url: this.options.startUrl },
      why: { options: 1, probability: 1 },
      outcome: "forced",
      error: `reopened the start page: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
      events: this.#oracles!.drain(),
      elapsedMs: 0,
    });
  }

  async #record(entry: TraceEntry): Promise<void> {
    this.#trace.push(entry);
    for (const event of entry.events) this.#failure(event, entry.step);
    await this.options.onStep?.(entry);
  }

  #failure(event: OracleEvent, step: number): void {
    if (this.#failures.has(event.signature)) return;
    this.#failures.set(event.signature, {
      signature: event.signature,
      kind: event.kind,
      message: event.message,
      step,
    });
  }

  /** Guided asks Jev's page kind; the heuristic only sees fields. */
  #formPage(observation: Observation, info: StateInfo): boolean {
    if (this.options.mode === "heuristic") return observation.fills.length > 0;
    return this.options.mode === "guided" && FORM_KINDS.has(info.kind ?? "");
  }

  async #canGoBack(): Promise<boolean> {
    // Navigation API entries are same-origin only, so index 0 is the first
    // in-origin page rather than the initial about:blank.
    return this.page
      .evaluate<boolean>("(window.navigation?.currentEntry?.index ?? 0) > 0")
      .catch(() => false);
  }

  async #stateInfo(observation: Observation): Promise<StateInfo> {
    const cached = this.#advice.get(observation.state);
    if (cached) return cached;
    const steering = this.options.mode === "guided";
    if (!steering && !this.options.measureKinds) return {};
    const { ids, targets } = adviceTargets(observation);
    const answer = await this.#assess(observation, targets, steering);
    // A failed call leaves this state unguided; the walk goes on.
    if (!answer) return {};
    (steering ? this.#calls : this.#measurementCalls).push(answer.call);
    const info: StateInfo = {
      kind: answer.kind.choice,
      ...(steering ? { advice: { answer, ids } } : {}),
    };
    this.#advice.set(observation.state, info);
    return info;
  }

  async #assess(
    observation: Observation,
    targets: ExploreAdviceRequest["targets"],
    steering: boolean,
  ): Promise<ExploreAdvice | undefined> {
    const advisor = this.options.advisor;
    if (!advisor) return undefined;
    const started = performance.now();
    const answer = await advisor
      .assess(
        {
          route: observation.route,
          title: observation.title,
          page: observation.text.slice(0, PAGE_TEXT_LIMIT),
          targets,
          kinds: PAGE_KINDS,
          predictTargets: steering && this.#tuning.predictTargets,
        },
        this.#callOptions(),
      )
      .catch((error: unknown) => this.#advisorFailed(error));
    this.#advisorMs.push(Math.round(performance.now() - started));
    return answer;
  }

  #callOptions(): { signal?: AbortSignal } {
    return this.options.signal ? { signal: this.options.signal } : {};
  }

  async #materialize(
    leaf: Leaf,
    observation: Observation,
  ): Promise<ExploreAction> {
    switch (leaf.kind) {
      case "click":
        return { kind: "click", target: leaf.identity! };
      case "type": {
        const source = await this.#inputSource(leaf, observation);
        return {
          kind: "type",
          target: leaf.identity!,
          value: this.#value(source, leaf),
          source,
        };
      }
      case "press":
        return { kind: "press", key: "Enter" };
      case "scroll":
        return {
          kind: "scroll",
          direction: this.#random.next() < 0.8 ? "down" : "up",
        };
      case "wait":
        return { kind: "wait", ms: 500 };
      case "form":
        return this.#planForm(leaf, observation);
      default:
        return { kind: leaf.kind };
    }
  }

  #heuristic(identity: TargetIdentity): string {
    return heuristicGenerator(identity.inputType ?? "text", identity.name);
  }

  /**
   * Plan valid Faker values for every field, then Enter. Only the first
   * action runs now; the rest run on the next steps while the route holds,
   * each recorded as its own atomic action.
   */
  async #planForm(
    leaf: Leaf,
    observation: Observation,
  ): Promise<ExploreAction> {
    const plan: ExploreAction[] = [];
    for (const fill of observation.fills) {
      const target = identityOf(observation.fills, fill, observation.url);
      const generator =
        this.options.mode === "guided"
          ? await this.#fieldGenerator(target, observation)
          : this.#heuristic(target);
      if (generator)
        plan.push({
          kind: "type",
          target,
          value: this.#generators.generate(generator),
          source: { kind: "faker", generator },
        });
    }
    plan.push({ kind: "press", key: "Enter" });
    const rest = plan.slice(1);
    this.#plan = rest.length
      ? {
          route: observation.route,
          destination: leaf.destination!,
          actions: rest,
        }
      : undefined;
    return plan[0]!;
  }

  /** The next planned action, while the page stays on the planned route. */
  #planned(observation: Observation): ExploreAction | undefined {
    const plan = this.#plan;
    if (!plan || plan.route !== observation.route) {
      this.#plan = undefined;
      return undefined;
    }
    const action = plan.actions.shift();
    if (!plan.actions.length) this.#plan = undefined;
    return action;
  }

  #value(source: InputSource, leaf: Leaf): string {
    const inputType = leaf.identity?.inputType ?? "text";
    if (source.kind === "faker")
      return this.#generators.generate(source.generator);
    if (source.kind === "hostile") return hostileText(this.#random);
    return blindValue(this.#random, inputType);
  }

  async #inputSource(
    leaf: Leaf,
    observation: Observation,
  ): Promise<InputSource> {
    const identity = leaf.identity!;
    if (this.options.mode === "random") return { kind: "random" };
    if (this.options.mode === "heuristic")
      return { kind: "faker", generator: this.#heuristic(identity) };
    const roll = this.#random.next();
    if (roll >= this.#tuning.validInput)
      return roll < this.#tuning.validInput + this.#tuning.hostileInput
        ? { kind: "hostile" }
        : { kind: "random" };
    const generator = await this.#fieldGenerator(identity, observation);
    return generator ? { kind: "faker", generator } : { kind: "random" };
  }

  /** Goal mode's closed Faker choice, asked once per field. */
  async #fieldGenerator(
    identity: TargetIdentity,
    observation: Observation,
  ): Promise<string | null> {
    const key = `${observation.route}|${identity.name}|${identity.inputType}`;
    if (this.#fieldGenerators.has(key)) return this.#fieldGenerators.get(key)!;
    const advisor = this.options.advisor;
    if (!advisor?.chooseGoalValue) return null;
    const started = performance.now();
    const selected = await advisor
      .chooseGoalValue(
        {
          goal: "Explore this site as a realistic user; fill this field with valid synthetic data so the form can be submitted",
          page: observation.text.slice(0, PAGE_TEXT_LIMIT),
          field: JSON.stringify({
            name: identity.name,
            role: identity.role,
            inputType: identity.inputType,
            location: identity.location,
          }),
          choices: {
            BLOCKED: "No synthetic generator fits this field",
            ...this.#generators.descriptions,
          },
        },
        this.#callOptions(),
      )
      .catch((error: unknown) => this.#advisorFailed(error));
    this.#advisorMs.push(Math.round(performance.now() - started));
    if (!selected) return null;
    this.#calls.push(selected.call);
    const choice = selected.value.choice;
    const generator = choice.startsWith("faker.") ? choice : null;
    this.#fieldGenerators.set(key, generator);
    return generator;
  }

  #advisorFailed(error: unknown): undefined {
    if (this.options.signal?.aborted) throw error;
    this.#advisorErrors.push(
      error instanceof Error ? error.message.slice(0, 200) : String(error),
    );
    return undefined;
  }

  #result(elapsedMs: number): ExploreResult {
    return {
      seed: this.options.seed,
      mode: this.options.mode,
      startUrl: this.options.startUrl,
      trace: this.#trace,
      failures: [...this.#failures.values()],
      states: this.#states.size,
      routes: [...this.#routes].sort(),
      kinds: Object.fromEntries(this.#coverage.visits),
      skippedDestructive: [...this.#skipped].sort(),
      calls: this.#calls,
      measurementCalls: this.#measurementCalls,
      advisorMs: this.#advisorMs,
      advisorErrors: this.#advisorErrors,
      excludedKinds: [...this.#excluded],
      elapsedMs: Math.round(elapsedMs),
    };
  }
}

/**
 * Explore a site from `startUrl` by a seeded, weighted random walk over
 * Sedum's candidate scanner, optionally guided by an advisor.
 */
export function explore(
  page: BrowserPage,
  options: ExploreOptions,
): Promise<ExploreResult> {
  return new Explorer(page, options).run();
}
