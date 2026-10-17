import type { Candidate } from "../../page-protocol.js";
import type { Observation } from "../observe.js";
import { foldName, onStartOrigin, pageTemplate } from "./template.js";
import {
  FORWARD,
  GLOBAL,
  NEEDS_FORM,
  VALUE,
  type Effect,
} from "./vocabulary.js";

/**
 * Controls that are the same thing: one control, or the repeated control of
 * a list's records (each product's link, each row's "Add to cart").
 */
export interface ControlClass {
  /** What makes two controls the same wherever they show: labels are cached by it. */
  readonly labelKey: string;
  readonly members: readonly Candidate[];
  readonly record: boolean;
  /** The template of the members' link, "" for none. */
  readonly hrefTemplate: string;
  /** A native dropdown's choosable options. */
  readonly options?: readonly string[];
}

/** One thing the planner can try, keyed so that the same thing gets one key. */
export interface Affordance {
  readonly key: string;
  readonly effect: Effect;
  /** The class it decays with: the same control on other pages of a kind. */
  readonly cls: string;
  /** Records are tried on this many different members. */
  readonly instances: number;
  readonly control: ControlClass;
  readonly option?: string;
}

/** An observation as the planner sees it. */
export interface PageView {
  readonly url: string;
  readonly template: string;
  readonly stateKey: string;
  /** Changes whenever anything visible changes. */
  readonly snapshot: string;
  readonly controls: readonly ControlClass[];
  readonly affordances: readonly Affordance[];
}

/** What the planner knows about a control: its effect, once Jev said. */
export type EffectOf = (control: ControlClass) => Effect | undefined;

/** A record repeats at least this often. */
const RECORD_MIN = 2;
/** A control on this many page templates is site chrome. */
export const CHROME_TEMPLATES = 3;
const CONTROL_LIMIT = 80;

/** Which templates each control shows on: chrome shows on all of them. */
export class Chrome {
  readonly #seenOn = new Map<string, Set<string>>();

  note(template: string, controls: readonly ControlClass[]): void {
    for (const control of controls) {
      const name = chromeName(control);
      const seen = this.#seenOn.get(name) ?? new Set<string>();
      seen.add(template);
      this.#seenOn.set(name, seen);
    }
  }

  templates(control: ControlClass): number {
    return this.#seenOn.get(chromeName(control))?.size ?? 0;
  }

  everywhere(control: ControlClass): boolean {
    return this.templates(control) >= CHROME_TEMPLATES;
  }
}

function chromeName(control: ControlClass): string {
  const first = control.members[0]!;
  return `${first.role}|${control.record ? control.labelKey : first.name}`;
}

/** Link records: distinct links that fold to one template. */
function linkGroup(candidate: Candidate, template: string): string | null {
  return candidate.signals.href
    ? `link|${candidate.role}|${candidate.location ?? ""}|${template}`
    : null;
}

/** Button records: the same name repeated, one per record. */
function buttonGroup(candidate: Candidate): string | null {
  return candidate.signals.href || candidate.tag === "select"
    ? null
    : `button|${candidate.role}|${foldName(candidate.name)}|${candidate.location ?? ""}`;
}

interface Grouped {
  readonly key: string;
  readonly template: string;
  readonly members: Candidate[];
}

function isRecordGroup(group: Grouped): boolean {
  if (group.members.length < RECORD_MIN) return false;
  if (group.key.startsWith("button|")) return true;
  // Links that point at one page are one control, such as "#" category links.
  const hrefs = new Set(group.members.map((c) => c.signals.href));
  return hrefs.size >= RECORD_MIN;
}

function singleKey(candidate: Candidate, template: string): string {
  return `${candidate.role}|${foldName(candidate.name)}|${template}`;
}

function addTo(
  groups: Map<string, Grouped>,
  key: string,
  template: string,
  candidate: Candidate,
): void {
  const group = groups.get(key) ?? { key, template, members: [] };
  group.members.push(candidate);
  groups.set(key, group);
}

/**
 * The page's on-origin click targets as control classes: records grouped,
 * the rest one class each. Unsafe targets are left out.
 */
export function controlClasses(
  observation: Observation,
  origin: string,
  options: ReadonlyMap<Candidate, readonly string[]> = new Map(),
  safe: (candidate: Candidate) => boolean = () => true,
): ControlClass[] {
  const clicks = inOpenDialog(observation.clicks);
  const records = new Map<string, Grouped>();
  for (const candidate of clicks) {
    if (!onStartOrigin(candidate.signals.href, observation.url, origin))
      continue;
    const template = hrefTemplate(candidate, observation.url);
    const key = linkGroup(candidate, template) ?? buttonGroup(candidate);
    if (key) addTo(records, key, template, candidate);
  }
  const recordOf = new Map<Candidate, Grouped>();
  for (const group of records.values())
    if (isRecordGroup(group))
      for (const member of group.members) recordOf.set(member, group);
  const classes = new Map<string, ControlClass>();
  for (const candidate of clicks) {
    if (!safe(candidate)) continue;
    if (!onStartOrigin(candidate.signals.href, observation.url, origin))
      continue;
    const record = recordOf.get(candidate);
    const template = hrefTemplate(candidate, observation.url);
    const labelKey = record
      ? `rec|${record.key}`
      : singleKey(candidate, template);
    const known = classes.get(labelKey);
    if (known) {
      (known.members as Candidate[]).push(candidate);
      continue;
    }
    const choices = options.get(candidate);
    classes.set(labelKey, {
      labelKey,
      members: [candidate],
      record: !!record,
      hrefTemplate: template,
      ...(choices ? { options: choices } : {}),
    });
  }
  return [...classes.values()].slice(0, CONTROL_LIMIT);
}

const IN_DIALOG = /\bdialog\b/u;

/**
 * While a dialog is open, only its controls can be used: the page behind it
 * shows but does not take clicks.
 */
function inOpenDialog(clicks: readonly Candidate[]): readonly Candidate[] {
  const dialog = clicks.filter((c) => IN_DIALOG.test(c.location ?? ""));
  return dialog.length ? dialog : clicks;
}

const IN_PAGE = /^(javascript:|#(?!!?\/))/iu;

function hrefTemplate(candidate: Candidate, base: string): string {
  const href = candidate.signals.href;
  // Script links and in-page anchors ("#") act on this page wherever it is.
  if (!href || IN_PAGE.test(href)) return "";
  return pageTemplate(href, base);
}

/**
 * A state is a route plus the form it shows and its step's forward
 * controls: overlays and headings do not split it, but each step of a
 * wizard that reuses "Proceed" does.
 */
export function stateKey(
  template: string,
  fields: readonly string[],
  forward: readonly string[],
): string {
  const join = (names: readonly string[], limit: number) =>
    foldName([...names].sort().join(",")).slice(0, limit);
  return [template, join(fields, 80), join(forward, 60)].join("|");
}

/** The heading of an open dialog, "" when it has none; undefined when none is open. */
export function openDialog(observation: Observation): string | undefined {
  const location = observation.clicks.find((c) =>
    IN_DIALOG.test(c.location ?? ""),
  )?.location;
  if (location === undefined) return undefined;
  return location.split(" · ")[1] ?? "";
}

/** Forward controls that belong to this step, not to every page. */
export function forwardNames(
  controls: readonly ControlClass[],
  effectOf: EffectOf,
  chrome: Chrome,
): string[] {
  return controls
    .filter((control) => {
      const effect = effectOf(control);
      const name = control.members[0]!.name;
      return (
        !!effect &&
        FORWARD.has(effect) &&
        chrome.templates(control) < CHROME_TEMPLATES &&
        !/^\d+$/u.test(name)
      );
    })
    .map((control) => control.members[0]!.name);
}

interface AffordanceContext {
  /** Where the affordances belong: the page template, or an open dialog. */
  readonly template: string;
  /** The page's own template. */
  readonly page: string;
  readonly stateKey: string;
  readonly effectOf: EffectOf;
  readonly chrome: Chrome;
}

/** The affordances of the page's controls, keyed by what they are. */
export function affordances(
  controls: readonly ControlClass[],
  context: AffordanceContext,
): Affordance[] {
  return controls.flatMap((control) => affordancesOf(control, context));
}

function affordancesOf(
  control: ControlClass,
  context: AffordanceContext,
): Affordance[] {
  const effect = effectHere(control, context);
  if (VALUE[effect] === 0) return [];
  // A disabled control is worth a try only as a submit its form may enable.
  if (control.members[0]!.disabled && !NEEDS_FORM.has(effect)) return [];
  if (control.record) return [recordAffordance(control, effect, context)];
  if (control.members[0]!.tag === "select")
    return selectAffordances(control, effect, context);
  return [controlAffordance(control, effect, context)];
}

/** A link to the page it is on moves nothing forward, whatever Jev calls it. */
function effectHere(control: ControlClass, context: AffordanceContext): Effect {
  const effect = context.effectOf(control) ?? "other";
  const samePage = control.hrefTemplate === context.page;
  return FORWARD.has(effect) && samePage ? "other" : effect;
}

/** A list's repeated control: one affordance, tried on two records. */
function recordAffordance(
  control: ControlClass,
  effect: Effect,
  context: AffordanceContext,
): Affordance {
  return {
    key: `${context.template}:record:${effect}:${control.labelKey}`,
    effect,
    cls: `${effect}|${control.labelKey}`,
    instances: 2,
    control,
  };
}

/** One affordance per option; a dropdown on every page is one site-wide. */
/** Dropdowns that change what a page lists or shows, tried option by option. */
const LIST_SELECTS: ReadonlySet<Effect> = new Set([
  "sort_items",
  "filter_items",
  "paginate",
  "toggle_view",
  "navigate_section",
]);
const SELECT_OPTIONS = 6;

function selectAffordances(
  control: ControlClass,
  effect: Effect,
  context: AffordanceContext,
): Affordance[] {
  const name = foldName(control.members[0]!.name);
  const everywhere =
    context.chrome.everywhere(control) && effect !== "sort_items";
  const scope = everywhere ? "*" : context.template;
  // Other dropdowns are form fields: the form filler chooses in them.
  if (!LIST_SELECTS.has(effect)) return [];
  return (control.options ?? []).slice(0, SELECT_OPTIONS).map((option) => ({
    key: `${scope}:select:${name.slice(0, 30)}:${option}`,
    effect,
    cls: `${effect}|${name.slice(0, 40)}`,
    instances: 1,
    control,
    option,
  }));
}

function controlAffordance(
  control: ControlClass,
  effect: Effect,
  context: AffordanceContext,
): Affordance {
  const first = control.members[0]!;
  const name = foldName(first.name);
  const global = siteWide(control, effect, context.chrome);
  // Site-wide keys use name and link together, so they stay the same once
  // the control turns out to show everywhere.
  const where = global
    ? `${name.slice(0, 50)}>${control.hrefTemplate}`
    : control.hrefTemplate || name.slice(0, 50);
  return {
    key: `${scopeOf(control, effect, global, context)}:${effect}:${first.role}:${where}`,
    effect,
    cls: toggleGroup(effect, first) ?? `${effect}|${name.slice(0, 40)}`,
    instances: 1,
    control,
  };
}

/** Chrome effects, and a forward control on every page (a tour's "Next"). */
function siteWide(
  control: ControlClass,
  effect: Effect,
  chrome: Chrome,
): boolean {
  if (GLOBAL.has(effect)) return true;
  return FORWARD.has(effect) && chrome.everywhere(control);
}

/** Forward controls belong to their step: a wizard reuses "Proceed" on every step. */
function scopeOf(
  control: ControlClass,
  effect: Effect,
  global: boolean,
  context: AffordanceContext,
): string {
  if (global) return "*";
  // A forward link goes somewhere: once per page, not once per step.
  const step = FORWARD.has(effect) && !control.hrefTemplate;
  return step ? context.stateKey : context.template;
}

/**
 * Toggles in one place (a language or currency menu) are one class: after
 * one, the others decay, so a menu of twenty languages costs a step or two.
 */
function toggleGroup(effect: Effect, first: Candidate): string | undefined {
  return effect === "toggle_view" && first.location
    ? `toggle_view|${first.location}`
    : undefined;
}

/**
 * Where a page's affordances belong: its template, or an open dialog,
 * which is the same dialog on whatever page it opens over.
 */
function scopeOfPage(observation: Observation, template: string): string {
  const dialog = openDialog(observation);
  return dialog === undefined
    ? template
    : `dialog:${foldName(dialog).slice(0, 40)}`;
}

/** Build the planner's view of an observation whose controls are labelled. */
export function pageView(
  observation: Observation,
  controls: readonly ControlClass[],
  effectOf: EffectOf,
  chrome: Chrome,
): PageView {
  const template = pageTemplate(observation.url);
  chrome.note(template, controls);
  const scope = scopeOfPage(observation, template);
  const key = stateKey(
    scope,
    observation.fills.map((fill) => fill.name),
    forwardNames(controls, effectOf, chrome),
  );
  return {
    url: observation.url,
    template,
    stateKey: key,
    snapshot: observation.state,
    controls,
    affordances: affordances(controls, {
      template: scope,
      page: template,
      stateKey: key,
      effectOf,
      chrome,
    }),
  };
}
