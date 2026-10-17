import type { PageView } from "./view.js";
import { FORWARD, GLOBAL, VALUE, type Effect } from "./vocabulary.js";

/** The key of an abstract state: template, form, forward controls. */
export type StateKey = string;
/** The key of an affordance: what it is, wherever it shows. */
export type AffordanceKey = string;
/** A route template, such as `/product/:id`. */
export type Template = string;

/** One abstract state: a route template, its form, its step's forward controls. */
export interface StateNode {
  readonly key: string;
  /** Loading this URL is the cheapest way back. */
  readonly url: string;
  /** Forward steps from the start that first reached it. */
  readonly depth: number;
  readonly offers: Set<string>;
  visits: number;
  /** False once loading the URL landed elsewhere. */
  restorable: boolean;
  failedTravel: number;
}

/** What the planner remembers about one affordance key. */
export interface AffordanceRecord {
  readonly effect: Effect;
  readonly template: string;
  readonly cls: string;
  tried: number;
  instances: number;
  /** Records of the control seen at most on one page. */
  members: number;
  /** Times it was opened again because the collection changed. */
  refreshes: number;
  /** Acting on it failed this often: something may have covered it. */
  failures: number;
  /** Acting on it failed too often: the target cannot be used. */
  blocked: boolean;
  /** A gate stopped it once; it was given another try. */
  gated: boolean;
  /** It stalled on incomplete fields once; it was filled again. */
  refilled: boolean;
}

/** A transition the walk observed, and whether replaying it is harmless. */
export interface Edge {
  readonly to: string;
  /** No server write: safe to replay as travel. */
  readonly clean: boolean;
}

/** How to reach a state: load a restorable state's URL, or not, then replay steps. */
export interface Route {
  /** The state whose URL is loaded first, or null to start from here. */
  readonly load: StateNode | null;
  /** Affordance keys to replay after the load. */
  readonly path: readonly AffordanceKey[];
  /** The state each replayed step should land in. */
  readonly expect: readonly StateKey[];
  /** 0 here, else a load and the replayed steps. */
  readonly distance: number;
}

/** The best thing to do next: an affordance in a state, and how to get there. */
export interface PlanChoice {
  readonly state: StateNode;
  readonly key: string;
  readonly score: number;
  readonly route: Route;
}

/** How the planner looks over the map. */
export interface PlanOptions {
  /**
   * Hysteresis: while the current state offers an open affordance this
   * accepts (a flow's forward step), the plan stays on it.
   */
  readonly focus?: (record: AffordanceRecord) => boolean;
  /** Replay steps that wrote, too: a fresh session has to redo them. */
  readonly dirty?: boolean;
  /** Paths longer than this are not replayed. */
  readonly maxPath?: number;
}

/** Each further try of a kind of control is worth this much less. */
export const DECAY = 0.35;
/** Forward steps gain this much value per level of depth. */
export const DEPTH_GAIN = 0.2;
/** Travel cost per step. */
export const TRAVEL_COST = 0.7;
/** Seeded tie-breaking: up to this much extra, so seeds take different paths. */
export const JITTER = 0.3;
/** Paths longer than this are not replayed. */
export const MAX_PATH = 4;
const MAX_FAILED_TRAVEL = 2;
/** Failed tries after which an affordance is given up. */
const MAX_FAILURES = 2;
/** Times a collection's controls are opened again after adds. */
const MAX_REFRESHES = 2;

export interface ScoreInput {
  readonly effect: Effect;
  readonly boost: number;
  readonly depth: number;
  readonly decay: number;
  /** A draw in [0, 1). */
  readonly jitter: number;
  readonly distance: number;
}

/** The planner's whole objective, for one affordance. */
export function score(input: ScoreInput): number {
  const deep = FORWARD.has(input.effect) ? 1 + DEPTH_GAIN * input.depth : 1;
  return (
    (VALUE[input.effect] *
      input.boost *
      deep *
      input.decay *
      (1 + JITTER * input.jitter)) /
    (1 + TRAVEL_COST * input.distance)
  );
}

/**
 * Class decay: forward and site-wide controls never lose value, except
 * toggles, which decay with the other toggles in their place.
 */
export function decay(effect: Effect, earlierTries: number): number {
  const exempt = GLOBAL.has(effect) && effect !== "toggle_view";
  if (exempt || FORWARD.has(effect)) return 1;
  return DECAY ** earlierTries;
}

type Edges = ReadonlyMap<StateKey, ReadonlyMap<AffordanceKey, Edge>>;

/**
 * The cheapest route to every state: replay known steps from here, or load
 * the URL of a state that loading restores and replay from there. Only
 * clean steps are replayed unless `dirty` is set.
 */
export function routes(
  edges: Edges,
  sources: readonly StateNode[],
  current: StateKey,
  options: Pick<PlanOptions, "dirty" | "maxPath"> = {},
): Map<StateKey, Route> {
  const maxPath = options.maxPath ?? MAX_PATH;
  const done = new Map<StateKey, Route>();
  const queue: [StateKey, Route][] = [
    [current, { load: null, path: [], expect: [], distance: 0 }],
    ...sources
      .filter((s) => s.key !== current)
      .map((s): [StateKey, Route] => [
        s.key,
        { load: s, path: [], expect: [], distance: 1 },
      ]),
  ];
  while (queue.length) {
    const [key, route] = takeNearest(queue);
    if (done.has(key)) continue;
    done.set(key, route);
    if (route.path.length >= maxPath) continue;
    for (const [affordance, edge] of edges.get(key) ?? []) {
      if ((!edge.clean && !options.dirty) || done.has(edge.to)) continue;
      queue.push([edge.to, extend(route, affordance, edge.to)]);
    }
  }
  return done;
}

function extend(route: Route, affordance: AffordanceKey, to: StateKey): Route {
  return {
    load: route.load,
    path: [...route.path, affordance],
    expect: [...route.expect, to],
    distance: route.distance + 1,
  };
}

/** The nearest queued route; on a tie, one that loads nothing. */
function takeNearest(queue: [StateKey, Route][]): [StateKey, Route] {
  const rank = ([, r]: [StateKey, Route]) => r.distance * 2 + (r.load ? 1 : 0);
  let best = 0;
  for (let i = 1; i < queue.length; i++)
    if (rank(queue[i]!) < rank(queue[best]!)) best = i;
  return queue.splice(best, 1)[0]!;
}

/** The abstract map of the app: states, what they offer, and how they connect. */
export class StateMap {
  readonly states = new Map<string, StateNode>();
  readonly records = new Map<string, AffordanceRecord>();
  readonly edges = new Map<string, Map<string, Edge>>();
  /** Affordance key to the key of the toggle that reveals it. */
  readonly revealedBy = new Map<string, string>();
  readonly #classTried = new Map<string, number>();
  /** Failed tries per control class: a control that never acts, anywhere. */
  readonly #classFailures = new Map<string, number>();
  /** Templates reached by opening the collection or stepping forward. */
  readonly collections = new Set<string>();
  /** Offers dropped because they were not shown; a sweep gives them back. */
  readonly #forgotten = new Map<StateKey, Set<AffordanceKey>>();
  /** Effect multipliers raised by gates; reset once the effect is taken. */
  boost: Partial<Record<Effect, number>> = {};

  /** Note a view of a state; a new state starts at `depth`. */
  learn(view: PageView, depth: number): StateNode {
    let node = this.states.get(view.stateKey);
    if (!node) {
      node = {
        key: view.stateKey,
        url: view.url,
        depth,
        offers: new Set(),
        visits: 0,
        restorable: true,
        failedTravel: 0,
      };
      this.states.set(view.stateKey, node);
    }
    node.visits++;
    for (const affordance of view.affordances) {
      node.offers.add(affordance.key);
      const members = affordance.control.members.length;
      const known = this.records.get(affordance.key);
      if (known) known.members = Math.max(known.members, members);
      else
        this.records.set(affordance.key, {
          effect: affordance.effect,
          template: view.template,
          cls: affordance.cls,
          tried: 0,
          instances: affordance.instances,
          members,
          refreshes: 0,
          failures: 0,
          blocked: false,
          gated: false,
          refilled: false,
        });
    }
    return node;
  }

  /** Count a try, for the affordance and for its classes. */
  tried(key: AffordanceKey): AffordanceRecord {
    const record = this.records.get(key)!;
    record.tried++;
    for (const cls of classesOf(record))
      this.#classTried.set(cls, (this.#classTried.get(cls) ?? 0) + 1);
    return record;
  }

  /** Earlier tries of the record's kind on its kind of page, or of its control. */
  earlierTries(record: AffordanceRecord): number {
    return Math.max(
      ...classesOf(record).map((c) => this.#classTried.get(c) ?? 0),
    );
  }

  /** A try that could not act: the control is given up, and its class after two. */
  failed(key: AffordanceKey): void {
    const record = this.records.get(key)!;
    record.blocked = true;
    record.failures++;
    this.#classFailures.set(
      record.cls,
      (this.#classFailures.get(record.cls) ?? 0) + 1,
    );
  }

  /** An effect that was boosted has been taken: its obligation is met. */
  discharge(effect: Effect): void {
    if (this.boost[effect]) this.boost = { ...this.boost, [effect]: 1 };
  }

  /** A page reached by opening the collection or stepping forward is part of it. */
  reached(effect: Effect, template: Template): void {
    if (FORWARD.has(effect) || effect === "open_collection")
      this.collections.add(template);
  }

  /** An add changed the page: visit the collection, and step forward from it. */
  added(): void {
    this.boost = { ...this.boost, open_collection: 3, proceed: 1.5 };
    this.refreshCollection();
  }

  /**
   * The state did not show the affordance this time: it is not reliably
   * there. A sweep gives it back, unless it is dead (`remember` false).
   */
  forget(state: StateKey, key: AffordanceKey, remember = true): void {
    if (!this.states.get(state)?.offers.delete(key) || !remember) return;
    const keys = this.#forgotten.get(state) ?? new Set<AffordanceKey>();
    keys.add(key);
    this.#forgotten.set(state, keys);
  }

  /**
   * Something was added: the collection and its forward steps hold
   * something new, so opening it and stepping forward are worth a try again.
   */
  refreshCollection(): void {
    for (const record of this.records.values()) {
      const collection =
        record.effect === "open_collection" ||
        (FORWARD.has(record.effect) && this.collections.has(record.template));
      if (!collection || record.tried < record.instances) continue;
      if (record.refreshes >= MAX_REFRESHES || record.blocked) continue;
      record.refreshes++;
      record.instances = record.tried + 1;
    }
  }

  /** Nothing left: try one more record of each list. False when none has more. */
  widen(): boolean {
    const lists = [...this.records.values()].filter(widenable);
    for (const record of lists) record.instances++;
    return lists.length > 0;
  }

  connect(
    from: StateKey,
    key: AffordanceKey,
    to: StateKey,
    clean: boolean,
  ): void {
    if (from === to) return;
    const out = this.edges.get(from) ?? new Map<string, Edge>();
    out.set(key, { to, clean });
    this.edges.set(from, out);
  }

  /** Affordances that showed only after `key` ran are revealed by it. */
  reveal(
    before: Iterable<AffordanceKey>,
    after: Iterable<AffordanceKey>,
    key: AffordanceKey,
  ): void {
    const shown = new Set(before);
    for (const affordance of after)
      if (!shown.has(affordance) && !this.revealedBy.has(affordance))
        this.revealedBy.set(affordance, key);
  }

  /** A state reached from another at the same URL: loading the URL gives the other one. */
  cameFrom(from: StateNode, to: StateNode, url: string): void {
    if (firstArrival(from, to) && url === from.url) to.restorable = false;
  }

  /** Re-arm records for one more try each; false when none was spent. */
  rearm(keys: Iterable<AffordanceKey>): boolean {
    let any = false;
    for (const key of keys) {
      const record = this.records.get(key);
      if (!record || !spent(record)) continue;
      record.instances = record.tried + 1;
      any = true;
    }
    return any;
  }

  /** Every remaining record of every list, and what was not shown, gets a try. */
  sweep(): boolean {
    let any = false;
    for (const record of this.records.values())
      if (widenable(record)) {
        record.instances = record.members;
        any = true;
      }
    for (const [state, keys] of this.#forgotten) {
      for (const key of keys) this.states.get(state)?.offers.add(key);
      any ||= keys.size > 0;
    }
    this.#forgotten.clear();
    return any;
  }

  /** Plan over the whole map: the best untried affordance anywhere, minus travel. */
  plan(
    current: StateKey,
    random: () => number,
    options: PlanOptions = {},
  ): PlanChoice | undefined {
    let best: PlanChoice | undefined;
    for (const option of this.#focused(
      this.#options(current, options),
      options,
    )) {
      const { state, record } = option;
      const value = score({
        effect: record.effect,
        boost: this.boost[record.effect] ?? 1,
        depth: state.depth,
        decay: decay(record.effect, this.earlierTries(record)),
        jitter: random(),
        distance: option.route.distance,
      });
      if (!best || value > best.score)
        best = { state, key: option.key, score: value, route: option.route };
    }
    return best;
  }

  /** Hysteresis: the current state's flow steps, when it has any. */
  #focused(options: Option[], plan: PlanOptions): Option[] {
    const focus = plan.focus;
    if (!focus) return options;
    const here = options.filter(
      (o) => o.route.distance === 0 && focus(o.record),
    );
    return here.length ? here : options;
  }

  /** Every open affordance in every reachable state, with how to get there. */
  #options(current: StateKey, plan: PlanOptions): Option[] {
    const sources = [...this.states.values()].filter(
      (s) => s.restorable && s.failedTravel < MAX_FAILED_TRAVEL,
    );
    const reach = routes(this.edges, sources, current, plan);
    return [...this.states.values()].flatMap((state) => {
      const route = reach.get(state.key);
      return route && this.#reachable(state, current)
        ? this.#openOffers(state, route)
        : [];
    });
  }

  #openOffers(state: StateNode, route: Route): Option[] {
    return [...state.offers].flatMap((key) => {
      const record = this.records.get(key)!;
      return this.#open(record) ? [{ state, key, record, route }] : [];
    });
  }

  #reachable(state: StateNode, current: StateKey): boolean {
    return state.key === current || state.failedTravel < MAX_FAILED_TRAVEL;
  }

  /** Untried, and neither it nor its control failed too often. */
  #open(record: AffordanceRecord): boolean {
    if (record.tried >= record.instances || record.blocked) return false;
    return (this.#classFailures.get(record.cls) ?? 0) < MAX_FAILURES;
  }
}

interface Option {
  readonly state: StateNode;
  readonly key: AffordanceKey;
  readonly record: AffordanceRecord;
  readonly route: Route;
}

/** A list tried on all its instances that has more records to try. */
function widenable(record: AffordanceRecord): boolean {
  if (record.instances < 2 || record.blocked) return false;
  return record.members > record.instances && record.tried >= record.instances;
}

/** Tried on all its instances, and not given up: one more try would be new. */
function spent(record: AffordanceRecord): boolean {
  return !record.blocked && record.tried >= record.instances;
}

/** The first time `to` was reached, from another state. */
function firstArrival(from: StateNode, to: StateNode): boolean {
  return to.visits === 1 && to.key !== from.key;
}

function classesOf(record: AffordanceRecord): string[] {
  return [`${record.template}|${record.effect}`, record.cls];
}
