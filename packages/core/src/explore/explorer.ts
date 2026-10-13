import type { BrowserPage } from "../browser-driver.js";
import { goalGenerators } from "../goal-data.js";
import type { Aim, Candidate } from "../page-protocol.js";
import { ProviderError, type ProviderCall } from "../provider.js";
import { stateDetections } from "../detector/page-checks.js";
import { DEFAULT_SEMANTIC_THRESHOLDS } from "../detector/semantic.js";
import { visibleText } from "../page-bridge.js";
import { actionTree, runAction, SiteChrome, type Leaf } from "./actions.js";
import { Coverage, guide } from "./guidance.js";
import { blindValue, heuristicGenerator, hostileText } from "./inputs.js";
import { looksDestructive, PAGE_KINDS } from "./kinds.js";
import { observe, onOrigin, settle, type Observation } from "./observe.js";
import { Oracles } from "./oracles.js";
import { Archive, returnPath, routeTemplate, type Cell } from "./archive.js";
import { FormFlow, type FormJudge } from "./form-flow.js";
import { JevJudge, RULE_JUDGE } from "./form-judge.js";
import {
  formatById,
  formatTools,
  FORMAT_DESCRIPTIONS,
  type FieldInfo,
  type FormatTools,
} from "./forms.js";
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
  type OracleOptions,
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
  /** A step still running after this long restarts the walk (default 60 s). */
  readonly stepTimeoutMs?: number;
  /** More origins to watch, and whether rejected submissions count. */
  readonly oracles?: OracleOptions;
  /**
   * "semantic" also asks the bug detector's page checks (an error shown,
   * stuck loading, empty content, a broken value) in each new state's Jev
   * call. Browser signals are always on.
   */
  readonly detect?: "browser" | "semantic";
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
  /** Successful writes per "METHOD endpoint", for a side-effect audit. */
  readonly writes: Readonly<Record<string, number>>;
  /** Returns to a frontier page, and distinct kinds of page archived. */
  readonly restores: number;
  readonly archived: number;
  /** Why the walk stopped before its step budget, if it did. */
  readonly stopReason?: string;
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
const STUCK_OUTSIDE = 6;
const STEP_TIMEOUT_MS = 60_000;

class StepTimeout extends Error {
  constructor(ms: number) {
    super(`The step took longer than ${ms / 1000} s; the page may be hung.`);
    this.name = "StepTimeout";
  }
}

/** Reject when `work` takes longer than `ms`; the work itself is not cancelled. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(ms)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
const FORM_KINDS = new Set(["form", "search", "auth"]);
const PAGE_TEXT_LIMIT = 3_000;
/** A request this side refused (too large, say) says nothing about Jev. */
function refusedLocally(error: unknown): boolean {
  return error instanceof ProviderError && error.code === "invalid-input";
}

/** Steps on pages with nothing to click or fill before the walk stops. */
const IDLE_STEPS = 15;
const ACTIONABLE: ReadonlySet<string> = new Set(["click", "type", "form"]);
/** Wait before loading the start page a second time. */
const START_RETRY_MS = 5_000;

/** How long a page that looks like it is loading must stay unchanged. */
const STUCK_MS = 3_000;

/** Consecutive failed Jev calls after which a guided walk stops. */
const GUIDE_FAILURES = 3;
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

/** The leaves advice ids are keyed by: every kind, no exclusions. */
function adviceLeaves(observation: Observation): Leaf[] {
  return actionTree({ observation, canGoBack: false, excluded: new Set() });
}

/** Click targets offered to the advisor, with ids by leaf index. */
function adviceTargets(observation: Observation): {
  ids: Map<number, string>;
  targets: Record<string, AdviceTarget>;
} {
  const ids = new Map<number, string>();
  const targets: Record<string, AdviceTarget> = {};
  adviceLeaves(observation).forEach((leaf, index) => {
    if (leaf.kind !== "click" || ids.size >= TARGET_LIMIT) return;
    const id = `t${ids.size}`;
    ids.set(index, id);
    targets[id] = adviceTarget(leaf.identity!);
  });
  return { ids, targets };
}

interface Plan {
  readonly kind: "form" | "restore";
  /** A form plan is dropped when the page moves to another route. */
  readonly route: string;
  readonly destination?: string;
  readonly actions: ExploreAction[];
}

function formPlan(observation: Observation, actions: ExploreAction[]): Plan {
  return {
    kind: "form",
    route: observation.route,
    destination: `${observation.route} form`,
    actions,
  };
}

/** A form plan stops when the page moves to another route. */
function leftForm(plan: Plan, observation: Observation): boolean {
  return plan.kind === "form" && plan.route !== observation.route;
}

/** An archive cell: a kind of page at a route, ids folded. */
function cellKey(observation: Observation, info: StateInfo): string {
  return `${routeTemplate(observation.route)}|${info.kind ?? ""}`;
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
  readonly #chrome = new SiteChrome();
  readonly #writes = new Map<string, number>();
  #outsideStreak = 0;
  #idleStreak = 0;
  #failStreak = 0;
  readonly #abandoned = new Set<number>();
  #stopReason: string | undefined;
  readonly #calls: ProviderCall[] = [];
  readonly #measurementCalls: ProviderCall[] = [];
  readonly #advisorMs: number[] = [];
  readonly #advisorErrors: string[] = [];
  #oracles: Oracles | undefined;
  #lastKind: ExploreActionKind | undefined;
  #plan: Plan | undefined;
  readonly #form: FormFlow;
  readonly #tools: FormatTools;
  readonly #archive = new Archive();
  #episode: ExploreAction[] = [];
  #episodeStart: string;
  #episodeClean = true;
  #returning: Cell | undefined;
  #restores = 0;
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
    this.#episodeStart = options.startUrl;
    this.#tools = formatTools(this.#random);
    this.#form = new FormFlow({
      page,
      tools: this.#tools,
      chooseGenerator: (target, observation, error) =>
        this.options.mode === "guided"
          ? this.#fieldGenerator(target, observation, error)
          : Promise.resolve(this.#heuristic(target)),
      generate: (generator, field) => this.#generate(generator, field),
      safe: (candidate) => this.#safe(candidate),
      judge: this.#judge(),
    });
    if (options.mode === "guided" && !options.advisor)
      throw new TypeError("Guided exploration needs an advisor");
  }

  /** A cold server (a sleeping demo host) may time out once; try again. */
  async #openStart(): Promise<void> {
    try {
      await this.page.goto(this.options.startUrl);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, START_RETRY_MS));
      await this.page.goto(this.options.startUrl);
    }
  }

  async run(): Promise<ExploreResult> {
    const started = performance.now();
    const steps = clampSteps(this.options.steps);
    await this.#openStart();
    await settle(this.page);
    this.#oracles = await Oracles.attach(
      this.page,
      this.#origin,
      this.options.oracles,
    );
    try {
      for (let step = 0; step < steps && this.#running(); step++)
        await withDeadline(this.#step(step), this.#stepTimeoutMs()).catch(
          (error: unknown) => this.#recover(step, error),
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
    this.#chrome.learn(observation);
    const info = await this.#stateInfo(observation);
    this.#markJudged(observation, info);
    if (this.#pendingDestination)
      this.#coverage.learn(this.#pendingDestination, info.kind);
    if (info.kind) this.#coverage.visit(info.kind);
    const cell = cellKey(observation, info);
    this.#noteArrival(cell);
    this.#archive.visit({
      key: cell,
      url: observation.url,
      episode: { start: this.#episodeStart, actions: this.#episode },
      clean: this.#episodeClean,
    });
    await this.#refreshPlan(observation, cell);
    if (!(await this.#continuePlan(step, observation, info)))
      await this.#choose(step, observation, info, cell);
  }

  /** Continue a form across attempts and pages, or return to a frontier. */
  async #refreshPlan(observation: Observation, cell: string): Promise<void> {
    if (this.#plan) return;
    if (this.#form.active) {
      const actions = await this.#form.next(observation);
      if (actions) {
        this.#plan = formPlan(observation, actions);
        return;
      }
    }
    if (!this.#archiveOn() || !this.#archive.due()) return;
    const target = this.#archive.pick(this.#random, cell);
    if (!target) return;
    this.#restores++;
    this.#returning = target;
    this.#plan = { kind: "restore", route: "", actions: returnPath(target) };
  }

  /** Once a return has run, check it reached the cell it aimed for. */
  #noteArrival(cell: string): void {
    if (!this.#returning || this.#plan) return;
    this.#archive.arrived(this.#returning, cell);
    this.#returning = undefined;
  }

  /**
   * Record this state's destructive verdicts before any plan runs, so a
   * form plan made outside the weighted pick never clicks such a target.
   */
  #markJudged(observation: Observation, info: StateInfo): void {
    const advice = info.advice;
    if (!advice) return;
    adviceLeaves(observation).forEach((leaf, index) => {
      const id = advice.ids.get(index);
      const p = id === undefined ? undefined : advice.answer.destructive[id];
      if (leaf.candidate && (p ?? 0) >= this.#tuning.skipDestructive)
        this.#coverage.markDangerous(leaf.candidate);
    });
  }

  /** Jev answers the form macro's questions in guided mode; rules otherwise. */
  #judge(): FormJudge {
    const advisor = this.options.advisor;
    if (this.options.mode !== "guided" || !advisor) return RULE_JUDGE;
    return new JevJudge({
      advisor,
      callOptions: () => this.#callOptions(),
      recorded: (call, ms) => {
        this.#calls.push(call);
        this.#failStreak = 0;
        this.#advisorMs.push(ms);
      },
      failed: (error) => this.#advisorFailed(error),
    });
  }

  /** A Faker value, or a format value for a `format.*` generator. */
  #generate(generator: string, field: FieldInfo): string {
    if (!generator.startsWith("format."))
      return this.#generators.generate(generator);
    return (
      formatById(generator, this.#tools, field) ||
      this.#generators.generate("faker.lorem.word")
    );
  }

  #archiveOn(): boolean {
    return this.#tuning.archive && this.options.mode !== "random";
  }

  /** Never click a target judged destructive, or named so under strict safety. */
  #safe(candidate: Candidate): boolean {
    if (this.#coverage.dangerous(candidate)) return false;
    return !(this.#tuning.strictSafety && looksDestructive(candidate.name));
  }

  #stepTimeoutMs(): number {
    return this.options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  }

  #running(): boolean {
    return !this.options.signal?.aborted && !this.#stopReason;
  }

  /** Run the next planned form action; false when no plan applies. */
  async #continuePlan(
    step: number,
    observation: Observation,
    info: StateInfo,
  ): Promise<boolean> {
    const plan = this.#plan;
    const destination = plan?.destination;
    const planned = this.#planned(observation);
    if (!planned) return false;
    const restore = plan?.kind === "restore";
    await this.#act(step, observation, info, planned, {
      options: 1,
      probability: 1,
      planned: true,
      ...(restore ? { restore } : {}),
    });
    this.#dropDivergedReturn(restore);
    this.#lastKind = planned.kind;
    // Learn where the whole form fill led once its last action ran.
    this.#pendingDestination = this.#plan ? undefined : destination;
    return true;
  }

  /** A return path that no longer replays is abandoned. */
  #dropDivergedReturn(restore: boolean): void {
    if (restore && this.#trace.at(-1)?.outcome === "failed")
      this.#plan = undefined;
  }

  /** Pick a fresh action from the weighted, guided tree and run it. */
  async #choose(
    step: number,
    observation: Observation,
    info: StateInfo,
    cell: string,
  ): Promise<void> {
    const formPage = this.#formPage(observation, info);
    const leaves = actionTree({
      formPage: formPage && (await this.#form.offers(observation)),
      observation,
      canGoBack: await this.#canGoBack(),
      ...(this.#lastKind ? { lastKind: this.#lastKind } : {}),
      lastRefused: this.#lastRefused(),
      excluded: this.#excluded,
      globalTargets: this.#chrome.targets,
    });
    this.#archive.untried(cell, this.#untried(leaves));
    this.#noteIdle(leaves, observation);
    const steering = this.options.mode === "guided" && info.advice;
    const guided = guide({
      mode: this.options.mode,
      leaves,
      coverage: this.#coverage,
      tuning: this.#tuning,
      formPage,
      afterTyping: this.#lastKind === "type",
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
    this.#learnFailure(leaf);
  }

  /**
   * A page with nothing to click or fill (a host's error page, a blank
   * screen) only offers scrolling and waiting: stop instead of idling.
   */
  #noteIdle(leaves: readonly Leaf[], observation: Observation): void {
    const actionable = leaves.some((leaf) => ACTIONABLE.has(leaf.kind));
    this.#idleStreak = actionable ? 0 : this.#idleStreak + 1;
    if (this.#idleStreak >= IDLE_STEPS)
      this.#stopReason ??= `Nothing to click or fill on ${observation.route} for ${IDLE_STEPS} steps.`;
  }

  #untried(leaves: readonly Leaf[]): number {
    return leaves.filter(
      (l) => l.kind === "click" && !this.#coverage.tried(l.destination!),
    ).length;
  }

  #lastRefused(): boolean {
    return /not_actionable/u.test(this.#trace.at(-1)?.error ?? "");
  }

  /** A target that could not be acted on loses weight everywhere it appears. */
  #learnFailure(leaf: Leaf): void {
    if (leaf.candidate && this.#trace.at(-1)?.outcome === "failed")
      this.#coverage.fail(leaf.candidate);
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
      events: await this.#oracles!.drain(),
      elapsedMs: Math.round(performance.now() - started),
    });
    await this.#enforceBoundary(step);
  }

  /** Bombadil's URL boundary: leaving the origin forces a step back. */
  async #enforceBoundary(step: number): Promise<void> {
    if (onOrigin(this.page.url, this.#origin)) {
      this.#outsideStreak = 0;
      return;
    }
    if (++this.#outsideStreak >= STUCK_OUTSIDE)
      this.#stopReason = `Left the site ${STUCK_OUTSIDE} times in a row; the session may have expired.`;
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
      events: await this.#oracles!.drain(),
      elapsedMs: 0,
    });
  }

  async #reopen(): Promise<void> {
    try {
      await withDeadline(this.page.goto(this.options.startUrl), 30_000);
      await settle(this.page);
    } catch {
      this.#stopReason =
        "The page stopped responding and could not be reopened.";
    }
  }

  /** A page that cannot be observed (crash, download, hang) restarts the walk. */
  async #recover(step: number, error: unknown): Promise<void> {
    if (this.options.signal?.aborted) throw error;
    // A hung step may still finish later; its late entry is dropped.
    this.#abandoned.add(step);
    const route = this.page.url;
    await this.#reopen();
    this.#pendingDestination = undefined;
    this.#plan = undefined;
    await this.#record({
      step,
      route,
      state: "unobservable",
      action: { kind: "goto", url: this.options.startUrl },
      why: { options: 1, probability: 1 },
      outcome: "forced",
      error: `reopened the start page: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
      events: await this.#oracles!.drain(),
      elapsedMs: 0,
    });
  }

  async #record(base: TraceEntry): Promise<void> {
    if (this.#abandoned.has(base.step) && base.outcome !== "forced") return;
    const writes = this.#oracles!.drainWrites();
    const entry = writes.length ? { ...base, writes } : base;
    for (const write of writes) {
      const key = `${write.method} ${write.endpoint}`;
      this.#writes.set(key, (this.#writes.get(key) ?? 0) + 1);
    }
    this.#trace.push(entry);
    this.#extendEpisode(entry);
    for (const event of entry.events) this.#failure(event, entry.step);
    await this.options.onStep?.(entry);
  }

  /** The clean path from the start page that the archive can replay. */
  #extendEpisode(entry: TraceEntry): void {
    if (entry.action.kind === "goto") {
      this.#episode = [];
      this.#episodeStart = entry.action.url;
      this.#episodeClean = true;
      return;
    }
    if (entry.writes?.length) this.#episodeClean = false;
    if (entry.outcome !== "failed") this.#episode.push(entry.action);
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
    // A checkout or an "Add account" dialog may sit on a page Jev calls a
    // cart or a detail page; two or more fields make it a form anyway.
    const fields =
      FORM_KINDS.has(info.kind ?? "") || observation.fills.length >= 2;
    return this.options.mode === "guided" && fields;
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
    if (answer.inspection)
      await this.#inspectState(observation, answer.inspection);
    const info: StateInfo = {
      kind: answer.kind.choice,
      ...(steering ? { advice: { answer, ids } } : {}),
    };
    this.#advice.set(observation.state, info);
    return info;
  }

  /**
   * The bug detector's page checks for a new state, from answers asked in
   * the same Jev call: an exact-text leak needs Jev's confirmation, and a
   * page that looks like it is loading must stay unchanged for 3 seconds.
   */
  async #inspectState(
    observation: Observation,
    inspection: NonNullable<ExploreAdvice["inspection"]>,
  ): Promise<void> {
    const loading =
      inspection.probabilities.stuck_loading >=
      DEFAULT_SEMANTIC_THRESHOLDS.stuck_loading;
    const text = (await visibleText(this.page).catch(() => null)) ?? "";
    const stuck = loading && (await this.#unchanged(text));
    const found = stateDetections(
      text,
      inspection,
      DEFAULT_SEMANTIC_THRESHOLDS,
      stuck,
    );
    this.#oracles!.report(found, routeTemplate(observation.route));
  }

  /** Whether the page's visible text stays the same for `STUCK_MS`. */
  async #unchanged(text: string): Promise<boolean> {
    const deadline = performance.now() + STUCK_MS;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const now = await visibleText(this.page).catch(() => null);
      if (now !== null && now !== text) return false;
    }
    return true;
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
          inspect: this.options.detect === "semantic",
        },
        this.#callOptions(),
      )
      .catch((error: unknown) => this.#advisorFailed(error));
    this.#advisorMs.push(Math.round(performance.now() - started));
    if (answer) this.#failStreak = 0;
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
        return { kind: "press", key: leaf.key ?? "Enter" };
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
    const plan = await this.#form.start(observation);
    if (!plan?.length) return { kind: "wait", ms: 500 };
    const [first, ...rest] = plan;
    this.#plan = rest.length
      ? { ...formPlan(observation, rest), destination: leaf.destination! }
      : undefined;
    return first!;
  }

  /** The next planned action, while the page stays on the planned route. */
  #planned(observation: Observation): ExploreAction | undefined {
    const plan = this.#plan;
    if (!plan || leftForm(plan, observation)) {
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
      return this.#generate(source.generator, {
        ref: "",
        empty: true,
        invalid: false,
        required: false,
        type: inputType,
        hints: (leaf.identity?.name ?? "").toLowerCase(),
      });
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
    error?: string,
  ): Promise<string | null> {
    const key = `${observation.route}|${identity.name}|${identity.inputType}|${error ?? ""}`;
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
            ...(error ? { error } : {}),
          }),
          choices: {
            BLOCKED: "No synthetic generator fits this field",
            ...FORMAT_DESCRIPTIONS,
            ...this.#generators.descriptions,
          },
        },
        this.#callOptions(),
      )
      .catch((error: unknown) => this.#advisorFailed(error));
    this.#advisorMs.push(Math.round(performance.now() - started));
    if (!selected) return null;
    this.#calls.push(selected.call);
    this.#failStreak = 0;
    const choice = selected.value.choice;
    const generator = /^(faker|format)\./u.test(choice) ? choice : null;
    this.#fieldGenerators.set(key, generator);
    return generator;
  }

  #advisorFailed(error: unknown): undefined {
    if (this.options.signal?.aborted) throw error;
    const message =
      error instanceof Error ? error.message.slice(0, 200) : String(error);
    this.#advisorErrors.push(message);
    if (!refusedLocally(error)) this.#guideFailed(message);
    return undefined;
  }

  /**
   * A guided walk without its guide is an unguided walk with Jev's safety
   * judgements missing: stop rather than carry on.
   */
  #guideFailed(message: string): void {
    this.#failStreak++;
    if (this.options.mode === "guided" && this.#failStreak >= GUIDE_FAILURES)
      this.#stopReason ??= `Jev stopped answering: ${message}`;
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
      writes: Object.fromEntries(this.#writes),
      restores: this.#restores,
      archived: this.#archive.size,
      ...(this.#stopReason ? { stopReason: this.#stopReason } : {}),
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
