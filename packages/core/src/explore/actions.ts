import type { BrowserPage } from "../browser-driver.js";
import type { Candidate } from "../page-protocol.js";
import {
  executeStep,
  ResolvedStepTarget,
  RuntimeUrl,
  RuntimeValue,
  type StepCommand,
} from "../step-executor.js";
import {
  allCandidates,
  findByIdentity,
  identityOf,
  sameOriginHref,
  settle,
  type Observation,
} from "./observe.js";
import type {
  ExploreAction,
  ExploreActionKind,
  TargetIdentity,
} from "./types.js";

export type LeafKind = Exclude<ExploreActionKind, "goto"> | "form";

/** One option in a state's action tree, before a value is generated. */
export interface Leaf {
  /** An action kind, or "form": fill every field with valid data, then submit. */
  readonly kind: LeafKind;
  /** Unguided weight, after Bombadil's defaults. */
  readonly base: number;
  readonly candidate?: Candidate;
  readonly identity?: TargetIdentity;
  /** Where a click leads: its link target, or the button on this route. */
  readonly destination?: string;
}

/**
 * After Bombadil's defaults (clicks 100, inputs 100, scroll 50, navigation
 * 10, wait 1). Bombadil only types into an already focused field, so typing
 * here gets half the click weight; scroll is low because it reveals no new
 * candidates (the scanner reads the whole page).
 */
const WEIGHTS = {
  click: 100,
  type: 50,
  press: 10,
  scroll: 5,
  back: 10,
  reload: 1,
  wait: 1,
  form: 40,
} as const;

export interface TreeContext {
  readonly observation: Observation;
  readonly canGoBack: boolean;
  readonly lastKind?: ExploreActionKind;
  /** Offer the planned form fill (guided and heuristic modes only). */
  readonly formPage?: boolean;
  /** Kinds left out of this run by swarm testing. */
  readonly excluded: ReadonlySet<ExploreActionKind>;
}

function clickLeaves(observation: Observation): Leaf[] {
  const allowed = observation.clicks.filter(
    (c) => sameOriginHref(c.signals.href, observation.url) !== null,
  );
  return allowed.map((candidate) => {
    const identity = identityOf(observation.clicks, candidate, observation.url);
    return {
      kind: "click",
      base: WEIGHTS.click / allowed.length,
      candidate,
      identity,
      destination: identity.href
        ? `link ${identity.href}`
        : `${observation.route} ${identity.role} ${identity.name}#${identity.occurrence}`,
    };
  });
}

function fillLeaves(observation: Observation): Leaf[] {
  return observation.fills.map((candidate) => {
    const identity = identityOf(observation.fills, candidate, observation.url);
    return {
      kind: "type",
      base: WEIGHTS.type / observation.fills.length,
      candidate,
      identity,
      destination: `${observation.route} type ${identity.name}#${identity.occurrence}`,
    };
  });
}

function otherLeaves(context: TreeContext): Leaf[] {
  const leaves: Leaf[] = [];
  if (context.formPage && context.observation.fills.length)
    leaves.push({
      kind: "form",
      base: WEIGHTS.form,
      destination: `${context.observation.route} form`,
    });
  if (context.observation.fills.length)
    leaves.push({
      kind: "press",
      base: WEIGHTS.press,
      destination: `${context.observation.route} press Enter`,
    });
  leaves.push({ kind: "scroll", base: WEIGHTS.scroll });
  if (context.canGoBack) leaves.push({ kind: "back", base: WEIGHTS.back });
  if (context.lastKind !== "reload" && context.lastKind !== "wait")
    leaves.push({ kind: "reload", base: WEIGHTS.reload });
  if (context.lastKind !== "wait")
    leaves.push({ kind: "wait", base: WEIGHTS.wait });
  return leaves;
}

/** The weighted action tree of one state, flattened, inside the origin. */
export function actionTree(context: TreeContext): Leaf[] {
  return [
    ...clickLeaves(context.observation),
    ...fillLeaves(context.observation),
    ...otherLeaves(context),
  ].filter((leaf) => leaf.kind === "form" || !context.excluded.has(leaf.kind));
}

export class ActionDivergence extends Error {
  constructor(readonly action: ExploreAction) {
    super(`No current target matches the recorded ${action.kind} action.`);
    this.name = "ActionDivergence";
  }
}

type TargetAction = Extract<ExploreAction, { kind: "click" | "type" }>;

/** Re-collect the operation and find the exact recorded target. */
async function freshTarget(
  page: BrowserPage,
  action: TargetAction,
): Promise<ResolvedStepTarget> {
  const operation = action.kind === "click" ? "click" : "fill";
  const fresh = await allCandidates(page, operation);
  const candidates = (fresh?.candidates ?? []).filter(
    (c) => !c.disabled && c.editable === (action.kind === "type"),
  );
  const candidate = fresh ? findByIdentity(candidates, action.target) : null;
  if (!fresh || !candidate) throw new ActionDivergence(action);
  return new ResolvedStepTarget({
    ref: candidate.ref,
    tag: candidate.tag,
    name: candidate.name,
    version: fresh.version,
  });
}

function targetCommand(
  action: TargetAction,
  target: ResolvedStepTarget,
): StepCommand {
  return action.kind === "click"
    ? { op: "click", target }
    : { op: "type", target, value: new RuntimeValue(action.value) };
}

/** Commands for actions that need no target, by kind. */
const PLAIN: {
  readonly [K in Exclude<ExploreActionKind, "click" | "type">]: (
    action: Extract<ExploreAction, { kind: K }>,
  ) => StepCommand;
} = {
  press: (action) => ({ op: "press", key: action.key }),
  scroll: (action) => ({
    op: "scroll",
    deltaY: action.direction === "down" ? 600 : -600,
  }),
  back: () => ({ op: "history", move: "back" }),
  reload: () => ({ op: "history", move: "reload" }),
  wait: (action) => ({ op: "wait", durationMs: action.ms }),
  goto: (action) => ({ op: "goto", url: new RuntimeUrl([action.url]) }),
};

async function command(
  page: BrowserPage,
  action: ExploreAction,
  target?: ResolvedStepTarget,
): Promise<StepCommand> {
  if (action.kind === "click" || action.kind === "type")
    return targetCommand(action, target ?? (await freshTarget(page, action)));
  const build = PLAIN[action.kind] as (action: ExploreAction) => StepCommand;
  return build(action);
}

/**
 * Run one recorded action and wait for the page to settle. Replays use the
 * same path, so every kind, including reload, can be reproduced.
 */
export async function runAction(
  page: BrowserPage,
  action: ExploreAction,
  target?: ResolvedStepTarget,
): Promise<void> {
  const step = await command(page, action, target);
  await executeStep(page, step, { timeoutMs: 10_000 });
  await settle(page);
}
