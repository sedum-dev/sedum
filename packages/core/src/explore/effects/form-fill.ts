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

/** A sign-in form has at most this many fields; a password is only made up for larger forms. */
const SIGN_IN_FIELDS = 3;
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
  if (role === "email") return email(context);
  if (role === "search_term")
    return context.searchWord ?? FIELD_VALUES.search_term;
  return FIELD_VALUES[role];
}

/**
 * Type into every empty or invalid field from its role, then answer
 * placeholder dropdowns and unanswered radio groups. A password is made up
 * only for a form too large to be a sign-in form.
 */
export async function fillActions(
  context: FillContext,
): Promise<ExploreAction[]> {
  const { observation } = context;
  const fields = await inspectFields(context.page, observation.fills);
  const byRef = new Map(observation.fills.map((c) => [c.ref, c]));
  const actions: ExploreAction[] = [];
  for (const field of fields) {
    const fill = byRef.get(field.ref);
    if (!fill || !needsValue(field)) continue;
    const role = field.type === "password" ? "password" : context.roleOf(fill);
    if (role === "password" && observation.fills.length <= SIGN_IN_FIELDS)
      continue;
    actions.push({
      kind: "type",
      target: identityOf(observation.fills, fill, observation.url),
      value: valueOf(role, field, fill, context),
      source: { kind: "faker", generator: `role.${role}` },
    });
  }
  // Dropdowns first: choosing a country may reset or re-check the fields.
  return [
    ...(await dropdownActions(context)),
    ...actions,
    ...(await choiceActions(context)),
  ];
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
): string {
  const retry = field.invalid ? context.retries(fill) : 0;
  const sampled =
    field.invalid && field.pattern
      ? samplePattern(field.pattern, context.random)
      : null;
  return sampled ?? valueFor(role, field, context, retry);
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

async function dropdownActions(context: FillContext): Promise<ExploreAction[]> {
  const { observation } = context;
  const dropdowns = await unansweredDropdowns(context.page, observation.fills);
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
