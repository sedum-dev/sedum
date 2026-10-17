import type { BrowserPage } from "../../browser-driver.js";
import type { Candidate } from "../../page-protocol.js";
import {
  inspectFields,
  unansweredChoices,
  unansweredDropdowns,
  type Dropdown,
  type FieldInfo,
} from "../forms.js";
import { identityOf, type Observation } from "../observe.js";
import { samplePattern } from "../pattern-sample.js";
import type { SeededRandom } from "../random.js";
import type { ExploreAction } from "../types.js";
import { FIELD_VALUES, type FieldRole } from "./vocabulary.js";

/** What filling a form needs from the planner. */
export interface FillContext {
  readonly page: BrowserPage;
  readonly observation: Observation;
  readonly roleOf: (fill: Candidate) => FieldRole;
  /** Never chosen in: a dropdown that sorts or filters a list. */
  readonly listControl: (candidate: Candidate) => boolean;
  readonly safe: (candidate: Candidate) => boolean;
  /** A per-run token, so a sign-up email is new on every run. */
  readonly token: string;
  /** A word from the page to search for. */
  readonly searchWord?: string;
  readonly random: SeededRandom;
  /** How often this field was filled while it showed as invalid before. */
  readonly retries: (fill: Candidate) => number;
  /** What password fields get; none are typed into without one. */
  readonly password: string | undefined;
  /** The run's account value for a role, once it has one. */
  readonly account: (role: FieldRole) => string | undefined;
  /** The control the form is filled for: only its form's fields are filled. */
  readonly target?: Candidate;
}

/** The fill actions for a form, and what each role was given. */
export interface FormFill {
  readonly actions: ExploreAction[];
  readonly typed: Partial<Record<FieldRole, string>>;
}

/** Other valid shapes to try when a field rejects the first one. */
const ALTERNATIVES: Partial<Record<FieldRole, readonly string[]>> = {
  postal_code: ["1234AB", "10115", "12345", "SW1A 1AA"],
  phone: ["0612345678", "+31612345678", "5551234567"],
  date: ["1990-05-17", "17/05/1990", "05/17/1990"],
  house_number: ["12", "12A"],
  card_expiry: ["12/2030", "12/30", "2030-12"],
};

/** Dropdown options that agree with the address the fields get. */
const AGREEING = new RegExp(
  `^(${[FIELD_VALUES.country, FIELD_VALUES.state, "NL"].join("|")})\\b`,
  "iu",
);

const SKIPPED_TYPES = new Set(["file", "checkbox", "radio", "range", "color"]);

type ValueContext = Pick<FillContext, "token" | "searchWord">;

/** Values an input type demands, whatever the field's role. */
const BY_TYPE: Readonly<
  Record<
    string,
    (field: Pick<FieldInfo, "min">, context: ValueContext) => string
  >
> = {
  date: () => FIELD_VALUES.date,
  number: (field) => String(Math.max(field.min ?? 3, 3)),
  email: (_field, context) => email(context),
};

function email(context: ValueContext): string {
  return `ada.lovelace+${context.token}@example.com`;
}

/** Values that must be new on every run: an account's identifiers. */
const PER_RUN: Partial<Record<FieldRole, (context: ValueContext) => string>> = {
  email,
  username: (context) => `${FIELD_VALUES.username}_${context.token}`,
};

/** The value a field gets from its role and its constraints. */
export function valueFor(
  role: FieldRole,
  field: Pick<FieldInfo, "type" | "min">,
  context: ValueContext,
  retry = 0,
): string {
  const alternatives = ALTERNATIVES[role];
  if (retry && alternatives) return alternatives[retry % alternatives.length]!;
  const byType = BY_TYPE[field.type];
  if (byType) return byType(field, context);
  const perRun = PER_RUN[role];
  if (perRun) return perRun(context);
  if (role === "search_term")
    return context.searchWord ?? FIELD_VALUES.search_term;
  return FIELD_VALUES[role];
}

/**
 * Type into every empty or invalid field from its role, then answer
 * placeholder dropdowns and unanswered radio groups. Password fields get
 * the context's password, or are left alone without one.
 */
export async function fillActions(context: FillContext): Promise<FormFill> {
  const { observation } = context;
  const fills = await formFills(context);
  const fields = await inspectFields(context.page, fills);
  const byRef = new Map(fills.map((c) => [c.ref, c]));
  const actions: ExploreAction[] = [];
  const typed: Partial<Record<FieldRole, string>> = {};
  for (const field of fields) {
    const fill = byRef.get(field.ref);
    if (!fill || !needsValue(field)) continue;
    const role = field.type === "password" ? "password" : context.roleOf(fill);
    const value = typedValue(role, field, fill, context);
    if (value === undefined) continue;
    typed[role] = value.text;
    actions.push({
      kind: "type",
      target: identityOf(observation.fills, fill, observation.url),
      value: value.text,
      source: { kind: "faker", generator: value.generator },
    });
  }
  // Dropdowns first: choosing a country may reset or re-check the fields.
  return {
    actions: [
      ...(await dropdownActions(context, fills)),
      ...actions,
      ...(await choiceActions(context)),
    ],
    typed,
  };
}

/** The account's value, the password, or a value from the role and constraints. */
function typedValue(
  role: FieldRole,
  field: FieldInfo,
  fill: Candidate,
  context: FillContext,
): { text: string; generator: string } | undefined {
  const account = context.account(role);
  if (account !== undefined)
    return { text: account, generator: `format.account.${role}` };
  if (role === "password")
    return context.password === undefined
      ? undefined
      : { text: context.password, generator: "format.newPassword" };
  return valueOf(role, field, fill, context);
}

/**
 * The fields of the target's form, when it is in one: a chat box or a
 * newsletter field elsewhere on the page is not part of it.
 */
const SAME_FORM = String.raw`((target, refs) => {
  const q = (ref) => document.querySelector('[data-sedum-ref="' + CSS.escape(ref) + '"]');
  const formOf = (e) => e.form || e.closest("form");
  const t = q(target);
  const form = t && formOf(t);
  if (!form) return refs;
  return refs.filter((ref) => { const e = q(ref); return !!e && formOf(e) === form; });
})`;

async function formFills(context: FillContext): Promise<readonly Candidate[]> {
  const { observation, target } = context;
  if (!target || !observation.fills.length) return observation.fills;
  const refs = JSON.stringify(observation.fills.map((c) => c.ref));
  const kept = await context.page
    .evaluate<string[]>(`${SAME_FORM}(${JSON.stringify(target.ref)}, ${refs})`)
    .catch(() => null);
  if (!kept) return observation.fills;
  const keep = new Set(kept);
  return observation.fills.filter((c) => keep.has(c.ref));
}

/** An empty or rejected field that takes typed text. */
function needsValue(field: FieldInfo): boolean {
  if (SKIPPED_TYPES.has(field.type)) return false;
  return field.empty || field.invalid;
}

/** A rejected field with a pattern gets a value made from the pattern. */
function valueOf(
  role: FieldRole,
  field: FieldInfo,
  fill: Candidate,
  context: FillContext,
): { text: string; generator: string } {
  const retry = field.invalid ? context.retries(fill) : 0;
  const sampled =
    field.invalid && field.pattern
      ? samplePattern(field.pattern, context.random)
      : null;
  if (sampled !== null) return { text: sampled, generator: "format.pattern" };
  return {
    text: valueFor(role, field, context, retry),
    generator: `format.field.${role}`,
  };
}

function selectOf(
  observation: Observation,
  dropdown: Dropdown,
): Candidate | undefined {
  const selects = observation.clicks.filter((c) => c.tag === "select");
  return (
    selects.find((c) => dropdown.label && c.name === dropdown.label) ??
    selects[dropdown.nth]
  );
}

/** Safe, and not a dropdown that sorts or filters a list. */
function choosable(select: Candidate, context: FillContext): boolean {
  return context.safe(select) && !context.listControl(select);
}

/**
 * Per usable select, in the order dropdowns are numbered, an option that
 * agrees with the address ("" for none): a long country list is cut short
 * before it reaches it.
 */
const AGREEING_OPTIONS = String.raw`(() => {
  const agrees = new RegExp(${JSON.stringify(AGREEING.source)}, "i");
  const visible = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const covered = (s) => {
    const b = s.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) return true;
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return !!top && top !== s && !s.contains(top);
  };
  const label = (o) => (o.label || o.text).replace(/\s+/g, " ").trim();
  return [...document.querySelectorAll("select")]
    .filter((s) => !s.disabled && !s.multiple && visible(s) && !covered(s))
    .map((s) => { const o = [...s.options].find((o) => o.value && agrees.test(label(o))); return o ? label(o) : ""; });
})()`;

async function dropdownActions(
  context: FillContext,
  fills: readonly Candidate[],
): Promise<ExploreAction[]> {
  const { observation } = context;
  const dropdowns = await unansweredDropdowns(context.page, fills);
  const agreeing = await agreeingOptions(context, dropdowns.length > 0);
  const actions: ExploreAction[] = [];
  for (const dropdown of dropdowns) {
    const option = optionFor(dropdown, agreeing);
    const select = option ? selectOf(observation, dropdown) : undefined;
    if (!select || !choosable(select, context)) continue;
    actions.push({
      kind: "click",
      target: identityOf(observation.clicks, select, observation.url),
      option: option!,
    });
  }
  return actions;
}

async function agreeingOptions(
  context: FillContext,
  needed: boolean,
): Promise<readonly string[]> {
  if (!needed) return [];
  return context.page
    .evaluate<string[]>(AGREEING_OPTIONS)
    .catch(() => [] as string[]);
}

/** A native dropdown's option: one agreeing with the address, else the first. */
function optionFor(
  dropdown: Dropdown,
  agreeing: readonly string[],
): string | undefined {
  const first = dropdown.native ? dropdown.options?.[0] : undefined;
  return first && (agreeing[dropdown.nth] || first);
}

async function choiceActions(context: FillContext): Promise<ExploreAction[]> {
  const { observation } = context;
  const groups = await unansweredChoices(context.page);
  const actions: ExploreAction[] = [];
  for (const group of groups) {
    const radio = observation.clicks.find(
      (c) => c.role === "radio" && group.options.includes(c.name),
    );
    if (!radio || !context.safe(radio)) continue;
    actions.push({
      kind: "click",
      target: identityOf(observation.clicks, radio, observation.url),
    });
  }
  return actions;
}
