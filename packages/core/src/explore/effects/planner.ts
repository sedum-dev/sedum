import type { BrowserPage } from "../../browser-driver.js";
import type { Candidate } from "../../page-protocol.js";
import { identityOf, type Observation } from "../observe.js";
import type { SeededRandom } from "../random.js";
import type { ChoiceWhy, ExploreAction, TraceEntry } from "../types.js";
import { fillActions } from "./form-fill.js";
import { fieldKey, type Labeler } from "./labeler.js";
import { StateMap, type StateNode } from "./state-map.js";
import {
  Chrome,
  controlClasses,
  pageView,
  type Affordance,
  type PageView,
} from "./view.js";
import { FORWARD, NEEDS_FORM, type Effect, type Gate } from "./vocabulary.js";

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

/** What the planner is doing across steps. */
interface Intent {
  readonly target: StateNode;
  readonly key: string;
  readonly score: number;
  /** Affordance keys still to replay before arriving. */
  path: string[];
  /** Travel replays known steps; else it loads the target's URL. */
  readonly viaPath: boolean;
  traveling: boolean;
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
  failed?: boolean;
  /** The target was covered or not ready: something may overlay the page. */
  refused?: boolean;
  wrote?: boolean;
  dialogs: number;
}

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

/** Reloads, then the start page, before the planner gives up. */
const RELOOKS = 3;
/** Rounds of trying one more record of each list once nothing else is left. */
const WIDENINGS = 3;

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
  readonly #origin: string;
  readonly #token: string;
  #queue: ExploreAction[] = [];
  #queueRoute = "";
  #intent: Intent | undefined;
  #pending: Pending | undefined;
  #current: StateNode | undefined;
  #relooks = 0;
  #widenings = 0;
  #dialogs = 0;
  /** Fills per field while it showed as invalid. */
  readonly #retries = new Map<string, number>();
  #observation: Observation | undefined;

  constructor(private readonly deps: EffectPlannerDeps) {
    this.#origin = new URL(deps.startUrl).origin;
    this.#token = String(deps.random.int(1000, 999_999));
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

  /** Observe, learn from the last action, and choose the next one. */
  async next(observation: Observation): Promise<PlannedStep | undefined> {
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
    const options = await selectOptions(this.deps.page, observation);
    const all = controlClasses(observation, this.#origin, options);
    await this.deps.labeler.label(observation, all);
    for (const control of all) this.#judge(control);
    const safe = controlClasses(
      observation,
      this.#origin,
      options,
      this.deps.safe,
    );
    return pageView(
      observation,
      safe,
      this.deps.labeler.effectOf,
      this.#chrome,
    );
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
    if (pending.kind === "travel") return this.#arrived(node);
    if (pending.kind !== "act") return;
    if (pending.failed) return this.#failed(pending, observation);
    const changed = this.#changed(pending, view);
    this.#connect(pending, view, node, changed);
    // An error message is a change but not progress: a forward step must
    // reach another state, write, or answer with a dialog.
    const progressed = node.key !== pending.from.key || this.#answered(pending);
    await this.#follow(pending, observation, view, progressed);
  }

  /** The target could not be used: retry once, after dismissing a cover. */
  #failed(pending: Pending, observation: Observation): void {
    this.map.failed(pending.key!);
    // A refused click usually means an overlay covers the page; dismiss it.
    if (pending.refused) {
      this.#queue = [{ kind: "press", key: "Escape" }];
      this.#queueRoute = observation.route;
    }
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
    this.map.boost = { ...this.map.boost, ...GATE_BOOSTS[gate] };
    // Fields are filled again on the retry; other gates wait for what clears them.
    const flag =
      gate === "complete_fields" || gate === "choose_option"
        ? "refilled"
        : "gated";
    if (record[flag]) return;
    record[flag] = true;
    this.#retry(record);
  }

  #retry(record: { tried: number; instances: number }): void {
    record.tried--;
    record.instances = Math.min(record.instances + 1, 3);
  }

  /** A travel step landed: on course, or the target is not reached that way. */
  #arrived(node: StateNode): void {
    const intent = this.#intent;
    if (!intent?.traveling) return;
    if (node.key === intent.target.key) {
      intent.traveling = false;
      intent.path = [];
      return;
    }
    if (intent.path.length) return;
    intent.target.failedTravel++;
    if (!intent.viaPath) intent.target.restorable = false;
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
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!this.#intended(node)) return this.#relook(node, view);
      const step = await this.#advance(observation, view, node);
      if (step) return step;
    }
    return this.#relook(node, view);
  }

  /** An intent to pursue: the current one, a new plan, or a wider list. */
  #intended(node: StateNode): boolean {
    return !!this.#intent || this.#plan(node) || this.#widen(node);
  }

  #fromQueue(observation: Observation): ExploreAction | undefined {
    if (observation.route !== this.#queueRoute) this.#queue = [];
    return this.#queue.shift();
  }

  /** Choose the best affordance on the whole map; false when none is left. */
  #plan(node: StateNode): boolean {
    const choice = this.map.plan(node.key, () => this.deps.random.next());
    if (!choice) return false;
    const here = choice.state.key === node.key;
    debug(
      `plan ${choice.key} in ${choice.state.key} (${choice.score.toFixed(2)}, ${here ? "here" : choice.path ? `path ${choice.path.length}` : "by URL"}) from ${node.key}`,
    );
    this.#intent = {
      target: choice.state,
      key: choice.key,
      score: choice.score,
      path: here ? [] : [...(choice.path ?? [])],
      viaPath: !here && choice.path !== null,
      traveling: !here,
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

  /** Content a slow request left out may be there now: reload, then restart. */
  #relook(node: StateNode, view: PageView): PlannedStep | undefined {
    if (this.#relooks >= RELOOKS) return undefined;
    this.#relooks++;
    const action: ExploreAction =
      this.#relooks === 1
        ? { kind: "reload" }
        : { kind: "goto", url: this.deps.startUrl };
    return this.#step("other", node, view, action, { planned: true });
  }

  /** One step towards the intent: travel, reveal, fill, or act. */
  async #advance(
    observation: Observation,
    view: PageView,
    node: StateNode,
  ): Promise<PlannedStep | undefined> {
    const intent = this.#intent!;
    if (intent.traveling) return this.#travel(intent, view, node);
    const affordance = findIntended(intent, view);
    if (!affordance) return this.#reveal(intent, view, node);
    intent.control = affordance.control.labelKey;
    intent.option = affordance.option;
    if (NEEDS_FORM.has(affordance.effect) && !intent.filled) {
      intent.filled = true;
      const fills = await this.#fills(observation, view, affordance);
      if (fills.length) {
        this.#queue = fills.slice(1);
        this.#queueRoute = observation.route;
        return this.#step("other", node, view, fills[0]!, { planned: true });
      }
    }
    return this.#act(intent, affordance, view, node);
  }

  #travel(
    intent: Intent,
    view: PageView,
    node: StateNode,
  ): PlannedStep | undefined {
    if (!intent.path.length)
      return this.#step(
        "travel",
        node,
        view,
        { kind: "goto", url: intent.target.url },
        { planned: true, restore: true },
      );
    const key = intent.path.shift()!;
    const affordance = view.affordances.find((a) => a.key === key);
    if (!affordance) {
      intent.target.failedTravel++;
      this.#intent = undefined;
      return undefined;
    }
    return this.#step("travel", node, view, this.#action(affordance, 0), {
      planned: true,
      restore: true,
      effect: affordance.effect,
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
    const actions = await fillActions({
      page: this.deps.page,
      observation,
      roleOf: (fill) => labeler.fieldRole(fill),
      listControl,
      safe: this.deps.safe,
      token: this.#token,
      random: this.deps.random,
      retries: (fill) => this.#invalidFills(fill),
      ...searchWord(view),
    });
    // Choosing an option is the act itself when the target is that dropdown.
    return actions.filter(
      (a) =>
        !(
          a.kind === "click" &&
          affordance.control.members.some((m) => m.name === a.target.name)
        ),
    );
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
    why: Partial<ChoiceWhy> & { key?: string; label?: string; effect?: Effect },
  ): PlannedStep {
    const { key, label, ...rest } = why;
    this.#pending = {
      kind,
      from: node,
      before: view,
      dialogs: this.#dialogs,
      ...(key ? { key } : {}),
      ...(why.effect ? { effect: why.effect } : {}),
      ...(label ? { label } : {}),
    };
    return {
      action,
      why: { options: view.affordances.length, probability: 1, ...rest },
    };
  }
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
