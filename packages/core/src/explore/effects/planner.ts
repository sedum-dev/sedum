import type { BrowserPage } from "../../browser-driver.js";
import type { Candidate } from "../../page-protocol.js";
import { identityOf, type Observation } from "../observe.js";
import type { SeededRandom } from "../random.js";
import type { ChoiceWhy, ExploreAction, TraceEntry } from "../types.js";
import { Credentials } from "./credentials.js";
import { fillActions } from "./form-fill.js";
import { fieldKey, type Labeler } from "./labeler.js";
import { deadTargets, DeadControls } from "./liveness.js";
import { SessionStart } from "./session.js";
import {
  StateMap,
  type AffordanceRecord,
  type PlanOptions,
  type StateNode,
} from "./state-map.js";
import {
  Chrome,
  controlClasses,
  pageView,
  type Affordance,
  type PageView,
} from "./view.js";
import {
  FIELD_VALUES,
  FORWARD,
  NEEDS_FORM,
  type Effect,
  type Gate,
} from "./vocabulary.js";

/** What the planner needs from the explorer. */
export interface EffectPlannerDeps {
  readonly page: BrowserPage;
  readonly startUrl: string;
  readonly random: SeededRandom;
  readonly labeler: Labeler;
  /** Never ends the session, and (with --safe) never destructive. */
  readonly safe: (candidate: Candidate) => boolean;
  /** Judged destructive at or above this probability (with --safe). */
  readonly skipDestructive: number;
  readonly markDangerous: (candidate: Candidate) => void;
}

/** The next action, and why, for the trace. */
export interface PlannedStep {
  readonly action: ExploreAction;
  readonly why: ChoiceWhy;
}

/** Getting to the target state: load a URL first, then replay steps. */
interface Travel {
  load: StateNode | null;
  readonly path: string[];
  /** The state each replayed step should land in. */
  readonly expect: string[];
  /** The next replayed step's form was filled. */
  filled: boolean;
}

/** What the planner is doing across steps. */
interface Intent {
  readonly target: StateNode;
  readonly key: string;
  readonly score: number;
  /** Set while travelling to the target. */
  travel: Travel | undefined;
  /** The control and option, once seen: filling a form may change the key. */
  control?: string;
  option?: string | undefined;
  filled: boolean;
  revealed: boolean;
}

/** The last action, to learn from once its result is observed. */
interface Pending {
  readonly kind: "act" | "travel" | "other";
  readonly from: StateNode;
  readonly before: PageView;
  readonly key?: string;
  readonly effect?: Effect;
  readonly label?: string;
  /** The label key of the clicked control. */
  readonly control?: string;
  /** Travel loaded this state's URL and should land in it. */
  readonly loaded?: StateNode;
  /** Travel replayed a step that should land in this state. */
  readonly expect?: string;
  failed?: boolean;
  /** The target was covered or not ready: something may overlay the page. */
  refused?: boolean;
  wrote?: boolean;
  dialogs: number;
}

/** Extra facts about a planned step, for the planner and the trace. */
type StepFacts = Partial<ChoiceWhy> &
  Pick<Pending, "key" | "label" | "effect" | "control" | "loaded" | "expect">;

/**
 * Once the plan is used up: reload once, then sweep what is left, then
 * replay to the deepest states in a fresh session, then hand the rest of
 * the budget to the walk planner.
 */
type Phase = "plan" | "reload" | "sweep" | "fresh" | "walk";
const NEXT_PHASE: Readonly<Record<Phase, Phase>> = {
  plan: "reload",
  reload: "sweep",
  sweep: "fresh",
  fresh: "walk",
  walk: "walk",
};

/** Diagnostics on stderr, for tuning the planner. */
const DEBUG = !!process.env.SEDUM_EFFECTS_DEBUG;
function debug(message: string): void {
  if (DEBUG) process.stderr.write(`  [effects] ${message}\n`);
}

/**
 * What clears each gate. Without an account, signing in is cleared by
 * another way forward on the page: a guest tab, or registering.
 */
const GATE_BOOSTS: Readonly<Record<Gate, Partial<Record<Effect, number>>>> = {
  add_items: { add_to_collection: 3, open_collection: 2 },
  sign_in: { toggle_view: 3, open_form: 1.5 },
  complete_fields: {},
  choose_option: {},
  nothing: {},
};

/** Rounds of trying one more record of each list once nothing else is left. */
const WIDENINGS = 3;
/** Attempts per step to find something that can be acted on now. */
const ATTEMPTS = 8;
/** A fresh session replays this many steps to reach a deep state. */
const FRESH_PATH = 12;
/** States this close to the deepest one are re-armed for a fresh session. */
const DEEP_BAND = 1;

/** Native dropdown options, in the scanner's order of selects. */
const SELECT_OPTIONS = String.raw`(() => {
  const PLACEHOLDER = /^(select|choose|pick|please (select|choose))\b|^(--|—|-)+$/i;
  const visible = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  return [...document.querySelectorAll("select")].filter(visible).map((s) =>
    [...s.options].filter((o) => !o.disabled && o.value && !PLACEHOLDER.test((o.label || o.text).trim()))
      .map((o) => (o.label || o.text).replace(/\s+/g, " ").trim()).slice(0, 12));
})()`;

async function selectOptions(
  page: BrowserPage,
  observation: Observation,
): Promise<Map<Candidate, readonly string[]>> {
  const selects = observation.clicks.filter((c) => c.tag === "select");
  if (!selects.length) return new Map();
  const options = await page
    .evaluate<string[][]>(SELECT_OPTIONS)
    .catch(() => [] as string[][]);
  // Only a one-to-one match is trusted; a modal hides the rest of the page.
  if (options.length !== selects.length) return new Map();
  return new Map(selects.map((select, index) => [select, options[index]!]));
}

/**
 * The effects planner: Jev labels what each control does, and code plans
 * over an abstract map of the app. One action per step: travel there, open
 * what reveals the control, fill the form, then act.
 */
export class EffectPlanner {
  readonly map = new StateMap();
  readonly #chrome = new Chrome();
  readonly #dead = new DeadControls();
  readonly #credentials = new Credentials();
  readonly #session: SessionStart;
  readonly #origin: string;
  readonly #token: string;
  #queue: ExploreAction[] = [];
  #queueRoute = "";
  #intent: Intent | undefined;
  #pending: Pending | undefined;
  #current: StateNode | undefined;
  #phase: Phase = "plan";
  #widenings = 0;
  #dialogs = 0;
  /** Fills per field while it showed as invalid. */
  readonly #retries = new Map<string, number>();
  /** Forward steps a sign-in gate stopped: tried again once signed in. */
  readonly #signInGated = new Set<string>();
  /** States with a sign-in form: where an account is used. */
  readonly #signInStates = new Set<string>();
  #observation: Observation | undefined;

  constructor(private readonly deps: EffectPlannerDeps) {
    this.#origin = new URL(deps.startUrl).origin;
    // New on every run, not only per seed: a sign-up must not meet an earlier run's account.
    this.#token = `${deps.random.int(1000, 999_999)}${Date.now().toString(36).slice(-4)}`;
    this.#session = new SessionStart(deps.page);
    deps.page.playwright?.().page.on("dialog", (dialog) => {
      this.#dialogs++;
      // Without a listener Playwright dismisses dialogs; keep doing so.
      dialog.dismiss().catch(() => undefined);
    });
  }

  /** The deepest state reached, for the result. */
  get maxDepth(): number {
    return Math.max(0, ...[...this.map.states.values()].map((s) => s.depth));
  }

  /** True once the planner handed the rest of the budget to the walk planner. */
  get done(): boolean {
    return this.#phase === "walk";
  }

  /**
   * Observe, learn from the last action, and choose the next one; undefined
   * once nothing is left and the walk planner should take over.
   */
  async next(observation: Observation): Promise<PlannedStep | undefined> {
    if (this.done) return undefined;
    this.#observation = observation;
    const view = await this.#see(observation);
    const node = this.map.learn(view, this.#depthIfNew());
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending) await this.#learn(pending, observation, view, node);
    this.#current = node;
    return this.#decide(observation, view, node);
  }

  /** The explorer ran the last action: did it fail, did it write? */
  after(entry: TraceEntry): void {
    if (!this.#pending) return;
    this.#pending.failed = entry.outcome === "failed";
    this.#pending.refused = /not_actionable/u.test(entry.error ?? "");
    this.#pending.wrote = !!entry.writes?.length;
  }

  async #see(observation: Observation): Promise<PageView> {
    const live = await this.#live(observation);
    const options = await selectOptions(this.deps.page, live);
    const all = controlClasses(live, this.#origin, options);
    await this.deps.labeler.label(live, all);
    for (const control of all) this.#judge(control);
    const safe = controlClasses(live, this.#origin, options, this.deps.safe);
    const view = pageView(live, safe, this.deps.labeler.effectOf, this.#chrome);
    if (signInForm(observation)) this.#signInStates.add(view.stateKey);
    // A control whose clicks changed nothing here is dead in this state.
    const affordances = view.affordances.filter(
      (a) => !this.#dead.dead(view.stateKey, a.control.labelKey),
    );
    return { ...view, affordances };
  }

  /**
   * The observation's click targets without those that cannot take a click
   * now, plus disabled buttons: a submit often waits for its form.
   */
  async #live(observation: Observation): Promise<Observation> {
    const dead = await deadTargets(this.deps.page, observation.clicks);
    if (dead.size)
      debug(`not clickable: ${[...dead].map((c) => c.name).join(", ")}`);
    const waiting = observation.disabled.filter(waitsForForm);
    if (!dead.size && !waiting.length) return observation;
    const clicks = observation.clicks.filter((c) => !dead.has(c));
    return { ...observation, clicks: [...clicks, ...waiting] };
  }

  /** With --safe, a control Jev judges destructive is never clicked again. */
  #judge(control: PageView["controls"][number]): void {
    const danger = this.deps.labeler.destructive(control);
    if (danger === undefined || danger < this.deps.skipDestructive) return;
    for (const member of control.members) this.deps.markDangerous(member);
  }

  #depthIfNew(): number {
    const pending = this.#pending;
    if (!pending) return this.#current?.depth ?? 0;
    if (pending.kind === "act") return pending.from.depth + 1;
    return this.#intent?.target.depth ?? pending.from.depth;
  }

  async #learn(
    pending: Pending,
    observation: Observation,
    view: PageView,
    node: StateNode,
  ): Promise<void> {
    if (pending.failed) return this.#failed(pending, observation);
    this.#idle(pending, view);
    if (pending.kind === "other") return;
    this.#account(node.key !== pending.from.key || this.#answered(pending));
    if (pending.kind === "travel") return this.#arrived(pending, node);
    const changed = this.#changed(pending, view);
    this.#connect(pending, view, node, changed);
    // An error message is a change but not progress: a forward step must
    // reach another state, write, or answer with a dialog.
    const progressed = node.key !== pending.from.key || this.#answered(pending);
    await this.#follow(pending, observation, view, progressed);
  }

  /** The target could not be used: give it up, after dismissing a cover. */
  #failed(pending: Pending, observation: Observation): void {
    if (pending.key && pending.kind === "act") this.map.failed(pending.key);
    if (pending.kind === "travel") this.#offCourse(pending);
    // A refused click usually means an overlay covers the page; dismiss it.
    if (pending.refused) {
      this.#queue = [{ kind: "press", key: "Escape" }];
      this.#queueRoute = observation.route;
    }
  }

  /** A click that changed nothing: twice in one state, and the control is dead there. */
  #idle(pending: Pending, view: PageView): void {
    const control = pending.control;
    if (!control || this.#changed(pending, view)) return;
    if (view.url !== pending.before.url) return;
    if (!this.#dead.idle(pending.from.key, control)) return;
    debug(`dead in ${pending.from.key}: ${control}`);
    for (const affordance of pending.before.affordances)
      if (affordance.control.labelKey === control)
        this.map.forget(pending.from.key, affordance.key, false);
  }

  /** A submitted form with a password made the account, or signed in with it. */
  #account(progressed: boolean): void {
    const outcome = this.#credentials.submitted(progressed);
    if (!outcome) return;
    debug(`account: ${outcome}`);
    if (outcome === "registered") {
      this.map.boost = { ...this.map.boost, sign_in: 3 };
      this.map.rearm(this.#signInSteps());
      return;
    }
    this.map.discharge("sign_in");
    this.map.rearm(this.#signInGated);
    this.#signInGated.clear();
  }

  /** Sign-in openers anywhere, and the forward steps of sign-in forms. */
  #signInSteps(): string[] {
    const keys: string[] = [];
    for (const [key, record] of this.map.records)
      if (record.effect === "sign_in") keys.push(key);
    for (const state of this.#signInStates)
      for (const key of this.map.states.get(state)?.offers ?? [])
        if (FORWARD.has(this.map.records.get(key)!.effect)) keys.push(key);
    return keys;
  }

  /** Anything visible changed, a dialog showed, or the server was written to. */
  #changed(pending: Pending, view: PageView): boolean {
    return view.snapshot !== pending.before.snapshot || this.#answered(pending);
  }

  /** The app answered without changing the page: a dialog, or a server write. */
  #answered(pending: Pending): boolean {
    return this.#dialogs > pending.dialogs || !!pending.wrote;
  }

  /** Record the edge, and what the action revealed on the same page. */
  #connect(
    pending: Pending,
    view: PageView,
    node: StateNode,
    changed: boolean,
  ): void {
    const key = pending.key!;
    this.map.connect(pending.from.key, key, node.key, !pending.wrote);
    this.map.cameFrom(pending.from, node, view.url);
    if (!changed || view.template !== pending.before.template) return;
    this.map.reveal(
      pending.before.affordances.map((a) => a.key),
      view.affordances.map((a) => a.key),
      key,
    );
  }

  /** What an effect obliges next: gates, the collection, boosts. */
  async #follow(
    pending: Pending,
    observation: Observation,
    view: PageView,
    progressed: boolean,
  ): Promise<void> {
    const effect = pending.effect!;
    this.map.discharge(effect);
    if (!progressed && FORWARD.has(effect))
      this.#gated(
        await this.deps.labeler.gate(observation, pending.label ?? ""),
        pending.key!,
      );
    if (view.template !== pending.before.template)
      this.map.reached(effect, view.template);
    // An add may answer only later (an alert, another origin's API): visit the collection anyway.
    if (effect === "add_to_collection") this.map.added();
  }

  /** A forward step stalled: raise what clears the gate, and come back to it once. */
  #gated(gate: Gate, key: string): void {
    debug(`gate for ${key}: ${gate}`);
    if (gate === "nothing") return;
    const record = this.map.records.get(key)!;
    this.map.boost = { ...this.map.boost, ...this.#boostsFor(gate) };
    if (gate === "sign_in") this.#signInGated.add(key);
    // Fields are filled again on the retry; other gates wait for what clears them.
    const flag =
      gate === "complete_fields" || gate === "choose_option"
        ? "refilled"
        : "gated";
    if (record[flag]) return;
    record[flag] = true;
    this.#retry(record);
  }

  /** With an account, a sign-in gate is cleared by signing in. */
  #boostsFor(gate: Gate): Partial<Record<Effect, number>> {
    const boosts = GATE_BOOSTS[gate];
    return gate === "sign_in" && this.#credentials.known
      ? { ...boosts, sign_in: 3 }
      : boosts;
  }

  #retry(record: { tried: number; instances: number }): void {
    record.tried--;
    record.instances = Math.min(record.instances + 1, 3);
  }

  /**
   * A travel step landed. A loaded URL that shows another state does not
   * restore its state; a replayed step that lands elsewhere ends the trip.
   */
  #arrived(pending: Pending, node: StateNode): void {
    const intent = this.#intent;
    if (!intent?.travel) return;
    if (!landedAsExpected(pending, node)) return this.#offCourse(pending);
    if (onTheWay(intent.travel)) return;
    if (node.key === intent.target.key) intent.travel = undefined;
    else this.#offCourse(pending);
  }

  #offCourse(pending: Pending): void {
    const intent = this.#intent;
    if (pending.loaded) {
      debug(
        `loading ${pending.loaded.url} does not restore ${pending.loaded.key}`,
      );
      pending.loaded.restorable = false;
    } else if (intent) intent.target.failedTravel++;
    this.#intent = undefined;
  }

  async #decide(
    observation: Observation,
    view: PageView,
    node: StateNode,
  ): Promise<PlannedStep | undefined> {
    const queued = this.#fromQueue(observation);
    if (queued)
      return this.#step("other", node, view, queued, { planned: true });
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (!this.#intended(node)) {
        const step = await this.#exhausted(node, view);
        if (step !== null) return step;
        continue;
      }
      const step = await this.#advance(observation, view, node);
      if (step) return step;
    }
    // Every intent fell through (nothing shown yet): let the page settle.
    const wait: ExploreAction = { kind: "wait", ms: 500 };
    return this.#step("other", node, view, wait, { planned: true });
  }

  /** An intent to pursue: the current one, a new plan, or a wider list. */
  #intended(node: StateNode): boolean {
    return !!this.#intent || this.#plan(node) || this.#widen(node);
  }

  /**
   * The plan is used up: move to the next phase. A step to take, null to
   * plan again, or undefined to hand over to the walk planner.
   */
  async #exhausted(
    node: StateNode,
    view: PageView,
  ): Promise<PlannedStep | undefined | null> {
    this.#phase = NEXT_PHASE[this.#phase];
    debug(`plan used up: ${this.#phase}`);
    if (this.#phase === "reload") {
      const reload: ExploreAction = { kind: "reload" };
      return this.#step("other", node, view, reload, { planned: true });
    }
    if (this.#phase === "sweep")
      return this.map.sweep() ? null : this.#exhausted(node, view);
    if (this.#phase === "fresh") return this.#fresh(node, view);
    return undefined;
  }

  /** A fresh session that replays its way back to the deepest states. */
  async #fresh(
    node: StateNode,
    view: PageView,
  ): Promise<PlannedStep | undefined | null> {
    if (!this.map.rearm(this.#deepest())) return this.#exhausted(node, view);
    await this.#session.restore(this.deps.page);
    this.#queue = [];
    this.#intent = undefined;
    const start: ExploreAction = { kind: "goto", url: this.deps.startUrl };
    return this.#step("other", node, view, start, {
      planned: true,
      restore: true,
    });
  }

  /** The page-scoped offers of the deepest states. */
  #deepest(): string[] {
    const floor = this.maxDepth - DEEP_BAND;
    return [...this.map.states.values()]
      .filter((state) => state.depth >= floor && state.depth > 0)
      .flatMap((state) => [...state.offers])
      .filter((key) => !key.startsWith("*:"));
  }

  #fromQueue(observation: Observation): ExploreAction | undefined {
    if (observation.route !== this.#queueRoute) this.#queue = [];
    return this.#queue.shift();
  }

  /** How to look over the map now: stay in a flow, and in a fresh session redo writes. */
  #planOptions(): PlanOptions {
    const signIn = !!this.#credentials.known && !this.#credentials.signedIn;
    const focus = (record: AffordanceRecord) =>
      FORWARD.has(record.effect) || (signIn && record.effect === "sign_in");
    return this.#phase === "fresh"
      ? { focus, dirty: true, maxPath: FRESH_PATH }
      : { focus };
  }

  /** Choose the best affordance on the whole map; false when none is left. */
  #plan(node: StateNode): boolean {
    const choice = this.map.plan(
      node.key,
      () => this.deps.random.next(),
      this.#planOptions(),
    );
    if (!choice) return false;
    const { route } = choice;
    const here = route.distance === 0;
    debug(
      `plan ${choice.key} in ${choice.state.key} (${choice.score.toFixed(2)}, ${here ? "here" : `${route.load ? "load + " : ""}${route.path.length} steps`}) from ${node.key}`,
    );
    this.#intent = {
      target: choice.state,
      key: choice.key,
      score: choice.score,
      travel: here
        ? undefined
        : {
            load: route.load,
            path: [...route.path],
            expect: [...route.expect],
            filled: false,
          },
      filled: false,
      revealed: false,
    };
    return true;
  }

  /** Nothing is left: one more record of each list, a few times over. */
  #widen(node: StateNode): boolean {
    if (this.#widenings >= WIDENINGS || !this.map.widen()) return false;
    this.#widenings++;
    debug(`widened lists (round ${this.#widenings})`);
    return this.#plan(node);
  }

  /** One step towards the intent: travel, reveal, fill, or act. */
  async #advance(
    observation: Observation,
    view: PageView,
    node: StateNode,
  ): Promise<PlannedStep | undefined> {
    const intent = this.#intent!;
    if (intent.travel)
      return this.#travel(intent.travel, observation, view, node);
    const affordance = findIntended(intent, view);
    if (!affordance) return this.#reveal(intent, view, node);
    intent.control = affordance.control.labelKey;
    intent.option = affordance.option;
    if (!intent.filled && this.#needsForm(affordance, observation)) {
      intent.filled = true;
      const fill = await this.#fillFirst(observation, view, node, affordance);
      if (fill) return fill;
    }
    if (affordance.control.members[0]!.disabled)
      return this.#stillDisabled(intent);
    return this.#act(intent, affordance, view, node);
  }

  /** A submit its filled form did not enable: give it up. */
  #stillDisabled(intent: Intent): undefined {
    debug(`still disabled after filling: ${intent.key}`);
    this.map.tried(intent.key);
    this.map.failed(intent.key);
    this.#intent = undefined;
    return undefined;
  }

  /**
   * Forms are filled before a forward step, a search, or signing in at a
   * password field; never before a link to another page, which submits nothing.
   */
  #needsForm(affordance: Affordance, observation: Observation): boolean {
    if (affordance.control.hrefTemplate) return false;
    if (NEEDS_FORM.has(affordance.effect)) return true;
    return (
      affordance.effect === "sign_in" &&
      observation.fills.some((f) => f.inputType === "password")
    );
  }

  /** Queue the form's fills; the first one is this step. */
  async #fillFirst(
    observation: Observation,
    view: PageView,
    node: StateNode,
    affordance: Affordance,
  ): Promise<PlannedStep | undefined> {
    const fills = await this.#fills(observation, view, affordance);
    if (!fills.length) return undefined;
    this.#queue = fills.slice(1);
    this.#queueRoute = observation.route;
    return this.#step("other", node, view, fills[0]!, { planned: true });
  }

  /** Load the first state's URL, then replay the path, filling forms on the way. */
  async #travel(
    travel: Travel,
    observation: Observation,
    view: PageView,
    node: StateNode,
  ): Promise<PlannedStep | undefined> {
    const load = travel.load;
    if (load) {
      travel.load = null;
      const goto: ExploreAction = { kind: "goto", url: load.url };
      return this.#step("travel", node, view, goto, {
        planned: true,
        restore: true,
        loaded: load,
      });
    }
    const affordance = view.affordances.find((a) => a.key === travel.path[0]);
    if (!affordance) {
      debug(`travel step not shown: ${travel.path[0]} in ${node.key}`);
      this.#intent!.target.failedTravel++;
      this.#intent = undefined;
      return undefined;
    }
    if (!travel.filled && this.#needsForm(affordance, observation)) {
      travel.filled = true;
      const fill = await this.#fillFirst(observation, view, node, affordance);
      if (fill) return fill;
    }
    return this.#replay(travel, affordance, view, node);
  }

  /** Replay one step of the path. */
  #replay(
    travel: Travel,
    affordance: Affordance,
    view: PageView,
    node: StateNode,
  ): PlannedStep {
    travel.path.shift();
    travel.filled = false;
    const expect = travel.expect.shift();
    return this.#step("travel", node, view, this.#action(affordance, 0), {
      planned: true,
      restore: true,
      effect: affordance.effect,
      control: affordance.control.labelKey,
      ...(expect === undefined ? {} : { expect }),
    });
  }

  /** A control that is not shown: open what revealed it once, else drop it. */
  #reveal(
    intent: Intent,
    view: PageView,
    node: StateNode,
  ): PlannedStep | undefined {
    const opener = this.map.revealedBy.get(intent.key);
    const affordance = opener && view.affordances.find((a) => a.key === opener);
    if (affordance && !intent.revealed) {
      intent.revealed = true;
      return this.#step("other", node, view, this.#action(affordance, 0), {
        planned: true,
        effect: affordance.effect,
        control: affordance.control.labelKey,
      });
    }
    debug(`not shown: ${intent.key} in ${view.stateKey}`);
    this.map.forget(node.key, intent.key);
    this.#intent = undefined;
    return undefined;
  }

  #act(
    intent: Intent,
    affordance: Affordance,
    view: PageView,
    node: StateNode,
  ): PlannedStep {
    const record = this.map.tried(intent.key);
    this.#intent = undefined;
    const action = this.#action(affordance, record.tried - 1);
    return this.#step("act", node, view, action, {
      effect: affordance.effect,
      score: Number(intent.score.toFixed(3)),
      key: intent.key,
      label: affordance.option ?? targetName(action),
      control: affordance.control.labelKey,
    });
  }

  async #fills(
    observation: Observation,
    view: PageView,
    affordance: Affordance,
  ): Promise<ExploreAction[]> {
    const labeler = this.deps.labeler;
    const listControl = (candidate: Candidate) => {
      const control = view.controls.find((c) => c.members.includes(candidate));
      const effect = control && labeler.effectOf(control);
      return effect === "sort_items" || effect === "filter_items";
    };
    const { actions, typed } = await fillActions({
      page: this.deps.page,
      observation,
      roleOf: (fill) => labeler.fieldRole(fill),
      listControl,
      safe: this.deps.safe,
      token: this.#token,
      random: this.deps.random,
      retries: (fill) => this.#invalidFills(fill),
      password: this.#password(affordance.effect),
      account: (role) => this.#credentials.valueFor(role),
      target: affordance.control.members[0]!,
      ...searchWord(view),
    });
    this.#credentials.typed(typed);
    // Choosing an option is the act itself when the target is that dropdown.
    return actions.filter(
      (a) =>
        !(
          a.kind === "click" &&
          affordance.control.members.some((m) => m.name === a.target.name)
        ),
    );
  }

  /** A sign-in step without an account has no password to type; any other form makes one up. */
  #password(effect: Effect): string | undefined {
    const known = this.#credentials.known?.password;
    if (known !== undefined || effect === "sign_in") return known;
    return FIELD_VALUES.password;
  }

  #invalidFills(fill: Candidate): number {
    const key = fieldKey(fill);
    const count = this.#retries.get(key) ?? 0;
    this.#retries.set(key, count + 1);
    return count;
  }

  /** The concrete action for an affordance: its `instance`-th record, or its option. */
  #action(affordance: Affordance, instance: number): ExploreAction {
    const members = affordance.control.members;
    const candidate = members[instance % members.length]!;
    const observation = this.#observation!;
    const target = identityOf(observation.clicks, candidate, observation.url);
    return affordance.option === undefined
      ? { kind: "click", target }
      : { kind: "click", target, option: affordance.option };
  }

  #step(
    kind: Pending["kind"],
    node: StateNode,
    view: PageView,
    action: ExploreAction,
    facts: StepFacts,
  ): PlannedStep {
    const { key, label, control, loaded, expect, ...why } = facts;
    this.#pending = {
      kind,
      from: node,
      before: view,
      dialogs: this.#dialogs,
      ...(key ? { key } : {}),
      ...(facts.effect ? { effect: facts.effect } : {}),
      ...(label ? { label } : {}),
      ...(control ? { control } : {}),
      ...(loaded ? { loaded } : {}),
      ...(expect === undefined ? {} : { expect }),
    };
    return {
      action,
      why: { options: view.affordances.length, probability: 1, ...why },
    };
  }
}

/** A disabled button that may wait for its form: not a link, not a dropdown. */
function waitsForForm(candidate: Candidate): boolean {
  return !candidate.signals.href && candidate.tag !== "select";
}

/** Most fields a sign-in form has besides its password: a sign-up asks for more. */
const SIGN_IN_FIELDS = 2;

/** A password field and few others: a form that signs in, not one that signs up. */
function signInForm(observation: Observation): boolean {
  const fills = observation.fills;
  const passwords = fills.filter((f) => f.inputType === "password").length;
  return passwords === 1 && fills.length - passwords <= SIGN_IN_FIELDS;
}

/** A travel step landed where its load or its replayed step should have. */
function landedAsExpected(pending: Pending, node: StateNode): boolean {
  const expected = pending.loaded?.key ?? pending.expect;
  return expected === undefined || node.key === expected;
}

/** Steps of the trip are still to come. */
function onTheWay(travel: Travel): boolean {
  return !!travel.load || travel.path.length > 0;
}

/** The intended affordance by key, or (after a fill changed the key) by control. */
function findIntended(intent: Intent, view: PageView): Affordance | undefined {
  return (
    view.affordances.find((a) => a.key === intent.key) ??
    (intent.control === undefined
      ? undefined
      : view.affordances.find(
          (a) =>
            a.control.labelKey === intent.control && a.option === intent.option,
        ))
  );
}

function targetName(action: ExploreAction): string {
  return action.kind === "click" ? action.target.name : action.kind;
}

/** A word to search for: the first word of a listed record's name. */
function searchWord(view: PageView): { searchWord?: string } {
  const record = view.controls.find((c) => c.record);
  const word = record?.members[0]?.name.split(/\s+/u)[0];
  return word && word.length >= 3 ? { searchWord: word } : {};
}
