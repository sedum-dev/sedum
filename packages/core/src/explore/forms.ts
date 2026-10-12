import { Faker, base, en, en_GB } from "@faker-js/faker";
import type { BrowserPage } from "../browser-driver.js";
import type { Candidate } from "../page-protocol.js";
import { samplePattern } from "./pattern-sample.js";
import type { SeededRandom } from "./random.js";

/** What a person sees about one field, read from the live element. */
export interface FieldInfo {
  readonly ref: string;
  readonly empty: boolean;
  readonly invalid: boolean;
  readonly required: boolean;
  readonly type: string;
  /** Label, placeholder, name, id and autocomplete, lowercased, for format rules. */
  readonly hints: string;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  /** The HTML pattern attribute: the value format the page enforces. */
  readonly pattern?: string;
  /** A submit control of the field's form, or the nearest save-like button after it. */
  readonly submit?: string;
}

/** Read field state and constraints for the collected fill candidates. */
export async function inspectFields(
  page: BrowserPage,
  fills: readonly Candidate[],
  afterSubmit = false,
): Promise<FieldInfo[]> {
  if (!fills.length) return [];
  const refs = JSON.stringify(fills.map((c) => c.ref));
  return page
    .evaluate<FieldInfo[]>(`(${INSPECT})(${refs}, ${afterSubmit})`)
    .catch(() => []);
}

/**
 * Radio groups in a form with nothing chosen yet, by the label of their
 * first option, such as "Does the client have a partner?" → "Yes".
 */
export async function unansweredChoices(page: BrowserPage): Promise<string[]> {
  return page.evaluate<string[]>(`(${UNANSWERED})()`).catch(() => []);
}

// Page scripts are plain JavaScript strings, like Sedum's other page code,
// so bundling never changes what runs in the page.
const INSPECT = String.raw`(refs, afterSubmit) => {
  const SAVE = /save|continue|next|submit|create|add|done|finish|confirm|apply|register|sign up/i;
  const ERROR = /required|invalid|should|must|please|not valid|incorrect/i;
  const text = (e) => ((e && e.textContent) || "").replace(/\s+/g, " ").trim();
  const submitOf = (field) => {
    const own = field.form && field.form.querySelector("button[type=submit], input[type=submit], button:not([type])");
    if (own) return text(own) || own.value;
    const after = [...document.querySelectorAll("button, [role=button]")].filter(
      (b) => field.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && SAVE.test(text(b)));
    return after.length ? text(after[0]) : undefined;
  };
  const errorNear = (field) => {
    let box = field.parentElement;
    // Stop at a box holding several controls: its errors belong to others.
    for (let depth = 0; box && depth < 3 && box.querySelectorAll("input, select, textarea").length <= 3; depth++, box = box.parentElement) {
      const own = text(box).replace(text(field), "");
      if (own.length < 200 && ERROR.test(own)) return true;
    }
    return false;
  };
  return refs.map((ref) => {
    const field = document.querySelector('[data-sedum-ref="' + CSS.escape(ref) + '"]');
    if (!field) return { ref, empty: false, invalid: false, required: false, type: "", hints: "" };
    const value = "value" in field ? field.value : text(field);
    const attr = (name) => field.getAttribute(name);
    const label = field.labels && field.labels[0] ? text(field.labels[0]) : "";
    const out = {
      ref,
      empty: !value,
      invalid: attr("aria-invalid") === "true" ||
        (!!value && typeof field.checkValidity === "function" && !field.checkValidity()) ||
        (afterSubmit && errorNear(field)),
      required: !!field.required || attr("aria-required") === "true",
      type: String(field.type || field.tagName).toLowerCase(),
      hints: [label, attr("placeholder"), attr("name"), field.id, attr("autocomplete"), attr("aria-label")]
        .filter(Boolean).join(" ").toLowerCase(),
    };
    if (attr("min") !== null) out.min = Number(attr("min"));
    if (attr("max") !== null) out.max = Number(attr("max"));
    if (field.maxLength > 0) out.maxLength = field.maxLength;
    if (attr("pattern")) out.pattern = attr("pattern").slice(0, 200);
    const submit = submitOf(field);
    if (submit) out.submit = submit.slice(0, 120);
    return out;
  });
}`;

const UNANSWERED = String.raw`() => {
  const groups = new Map();
  for (const radio of document.querySelectorAll("input[type=radio]")) {
    if (!radio.name || radio.disabled) continue;
    const box = radio.getBoundingClientRect();
    if (!box.width && !box.height && !radio.labels?.length) continue;
    const list = groups.get(radio.name) || [];
    list.push(radio);
    groups.set(radio.name, list);
  }
  const labelOf = (r) => ((r.labels && r.labels[0] && r.labels[0].textContent) || r.getAttribute("aria-label") || r.value || "").replace(/\s+/g, " ").trim();
  return [...groups.values()].filter((list) => !list.some((r) => r.checked)).map((list) => labelOf(list[0])).filter(Boolean);
}`;

/** A dropdown nobody has chosen in yet, in the form being completed. */
export interface Dropdown {
  /** A native select (chosen in one click) or a custom trigger. */
  readonly native: boolean;
  /**
   * Which one among the page's selects (native), or among triggers showing
   * the same text (custom): candidate refs do not survive a later scan.
   */
  readonly nth: number;
  /** Its label, such as "Wrapper type"; "" when none is near. */
  readonly label: string;
  /** What it shows now, such as "Select a wrapper type". */
  readonly shown: string;
  /** Options of a native select; a custom one lists them once opened. */
  readonly options?: readonly string[];
}

/** Dropdowns in the form around these fields that show a placeholder. */
export async function unansweredDropdowns(
  page: BrowserPage,
  fills: readonly Candidate[],
): Promise<Dropdown[]> {
  const refs = JSON.stringify(fills.map((c) => c.ref));
  return page.evaluate<Dropdown[]>(`(${DROPDOWNS})(${refs})`).catch(() => []);
}

/** The form's visible lines, to tell which error lines a submit added. */
export async function formLines(
  page: BrowserPage,
  fills: readonly Candidate[],
): Promise<string[]> {
  const refs = JSON.stringify(fills.map((c) => c.ref));
  return page.evaluate<string[]>(`(${LINES})(${refs})`).catch(() => []);
}

const ERROR_LINE =
  /required|invalid|must|should|please|incorrect|not valid|error|too (long|short)|at least|at most|missing/iu;

/** Error lines a submit added to the form, such as a summary box. */
export function newErrorLines(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const seen = new Set(before);
  return [...new Set(after)]
    .filter((line) => !seen.has(line) && ERROR_LINE.test(line))
    .slice(0, 12);
}

/** Placeholder text of a dropdown nobody has chosen in yet. */
export const PLACEHOLDER =
  /^(select|choose|pick|please (select|choose))\b(?! all\b| file\b)|^(--|—|-)+|^…$|^\.\.\.$/iu;

// The form around some fields: their own form, an open dialog, or the
// nearest ancestor that also holds a save-like button.
const SCOPE = String.raw`(refs) => {
  const SAVE = /save|continue|next|submit|create|add|done|finish|confirm|apply|register|sign up/i;
  const text = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\s+/g, " ").trim();
  const fields = refs.map((ref) => document.querySelector('[data-sedum-ref="' + CSS.escape(ref) + '"]')).filter(Boolean);
  if (!fields.length) return document.querySelector("[role=dialog], [aria-modal=true], dialog[open]") || document.body;
  const first = fields[0];
  if (first.form) return first.form;
  const dialog = first.closest("[role=dialog], [aria-modal=true], dialog");
  if (dialog) return dialog;
  let box = first.parentElement;
  while (box && !fields.every((f) => box.contains(f))) box = box.parentElement;
  for (let depth = 0; box && box !== document.body && depth < 6; depth++, box = box.parentElement)
    if ([...box.querySelectorAll("button, [role=button], input[type=submit]")].some((b) => SAVE.test(text(b) || b.value || ""))) return box;
  return box || document.body;
}`;

const LINES = String.raw`(refs) => {
  const scope = (${SCOPE})(refs);
  const lines = (scope.innerText || "").split("\n");
  for (const alert of document.querySelectorAll("[role=alert]")) lines.push(...(alert.innerText || "").split("\n"));
  return lines.map((l) => l.replace(/^[\s•·\-–*]+/, "").replace(/\s+/g, " ").trim()).filter((l) => l && l.length <= 160);
}`;

const DROPDOWNS = String.raw`(refs) => {
  const PLACEHOLDER = ${PLACEHOLDER};
  const text = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\s+/g, " ").trim();
  const scope = (${SCOPE})(refs);
  const visible = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  // The label element, else the nearest short text before the dropdown.
  const textBefore = (box) => {
    let prev = box.previousElementSibling;
    while (prev && !text(prev)) prev = prev.previousElementSibling;
    return prev ? text(prev) : null;
  };
  const labelBefore = (el) => {
    let box = el;
    for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
      const before = textBefore(box);
      if (before !== null) return before.length <= 60 ? before : "";
    }
    return "";
  };
  const labelOf = (el) =>
    (el.labels && el.labels[0] && text(el.labels[0])) || el.getAttribute("aria-label") || labelBefore(el);
  const out = [];
  const selects = [...document.querySelectorAll("select")].filter((s) => !s.disabled && !s.multiple && visible(s));
  for (const select of scope.querySelectorAll("select")) {
    if (!selects.includes(select)) continue;
    const chosen = select.selectedOptions[0];
    if (select.value && chosen && !PLACEHOLDER.test(text(chosen))) continue;
    const options = [...select.options]
      .filter((o) => !o.disabled && o.value && !PLACEHOLDER.test(o.label || o.text))
      .map((o) => (o.label || o.text).replace(/\s+/g, " ").trim()).slice(0, 60);
    if (options.length) out.push({ native: true, nth: selects.indexOf(select), label: labelOf(select), shown: chosen ? text(chosen) : "", options });
  }
  const seen = new Set();
  for (const el of scope.querySelectorAll("*")) {
    if (el.matches("select, option, input, textarea, script, style, a[href]") || el.closest("select")) continue;
    if (el.children.length > 3) continue;
    const own = text(el);
    if (!own || own.length > 60 || !PLACEHOLDER.test(own) || !visible(el)) continue;
    // The clickable element: itself, or the nearest ancestor with a pointer.
    let trigger = el;
    while (trigger !== scope && getComputedStyle(trigger).cursor !== "pointer" && trigger.parentElement) trigger = trigger.parentElement;
    if (trigger === scope || seen.has(trigger)) continue;
    seen.add(trigger);
    const nth = out.filter((d) => !d.native && d.shown === own).length;
    out.push({ native: false, nth, label: labelOf(trigger), shown: own });
  }
  return out;
}`;

/** A field that is mostly a part of a date, a postcode, a phone number… */
interface FormatRule {
  readonly id: string;
  readonly test: (field: FieldInfo) => boolean;
  readonly value: (tools: FormatTools, field: FieldInfo) => string;
}

export interface FormatTools {
  readonly random: SeededRandom;
  readonly faker: Faker;
}

const pad = (n: number) => String(n).padStart(2, "0");

const AREAS = ["SW", "N", "E", "LS", "M", "B", "BT", "EH", "CF", "NE"];
const UNIT_LETTERS = "ABDEFGHJLNPQRSTUWXYZ";

/** A well-formed UK postcode, such as "LS12 4QT". */
function ukPostcode(random: SeededRandom): string {
  const letter = () => UNIT_LETTERS[random.int(0, UNIT_LETTERS.length - 1)];
  const area = AREAS[random.int(0, AREAS.length - 1)];
  return `${area}${random.int(1, 20)} ${random.int(1, 9)}${letter()}${letter()}`;
}
const has = (field: FieldInfo, pattern: RegExp) => pattern.test(field.hints);

const RULES: readonly FormatRule[] = [
  {
    id: "format.password",
    test: (f) => f.type === "password",
    value: () => "",
  },
  {
    id: "format.pattern",
    test: (f) => !!f.pattern,
    value: (t, f) => samplePattern(f.pattern!, t.random) ?? "",
  },
  {
    id: "format.day",
    test: (f) => has(f, /(^|\s)(dd|day)(\s|$)/u),
    value: (t) => pad(t.random.int(1, 28)),
  },
  {
    id: "format.month",
    test: (f) => has(f, /(^|\s)(mm|month)(\s|$)/u),
    value: (t) => pad(t.random.int(1, 12)),
  },
  {
    id: "format.year",
    test: (f) => has(f, /(^|\s)(yyyy|year)(\s|$)/u),
    value: (t) => String(t.random.int(1950, 1995)),
  },
  {
    id: "format.date",
    test: (f) => f.type === "date",
    value: (t) =>
      `${t.random.int(1950, 1995)}-${pad(t.random.int(1, 12))}-${pad(t.random.int(1, 28))}`,
  },
  {
    id: "format.sortCode",
    test: (f) => has(f, /sort ?code/u),
    value: (t) => [0, 0, 0].map(() => pad(t.random.int(0, 99))).join("-"),
  },
  {
    id: "format.niNumber",
    test: (f) => has(f, /national insurance|\bni (number|no)\b|\bnino\b/u),
    value: (t) =>
      `QQ${String(t.random.int(0, 999999)).padStart(6, "0")}${"ABCD"[t.random.int(0, 3)]}`,
  },
  {
    id: "format.iban",
    test: (f) => has(f, /\biban\b/u),
    value: (t) => t.faker.finance.iban({ formatted: false, countryCode: "GB" }),
  },
  {
    id: "format.accountNumber",
    test: (f) => has(f, /account (number|no\b|id\b)/u),
    value: (t) => String(t.random.int(10_000_000, 99_999_999)),
  },
  {
    id: "format.ukPostcode",
    test: (f) => has(f, /post ?code/u),
    value: (t) => ukPostcode(t.random),
  },
  {
    id: "format.zip",
    test: (f) => has(f, /\bzip\b/u),
    value: (t) => String(t.random.int(10000, 99999)),
  },
  {
    id: "format.email",
    test: (f) => f.type === "email" || has(f, /e-?mail/u),
    value: (t) =>
      `${t.faker.person.firstName()}.${t.faker.person.lastName()}${t.random.int(1, 999)}@example.com`.replace(
        /[^\w.@+-]/gu,
        "",
      ),
  },
  {
    id: "format.phone",
    test: (f) => f.type === "tel" || has(f, /phone|mobile/u),
    value: (t) => `07${String(t.random.int(100000000, 999999999))}`,
  },
  {
    id: "format.number",
    test: (f) =>
      f.type === "number" || f.min !== undefined || f.max !== undefined,
    value: (t, f) =>
      String(
        t.random.int(f.min ?? 1, f.max ?? Math.max(10, (f.min ?? 1) + 50)),
      ),
  },
  {
    id: "format.amount",
    test: (f) => has(f, /balance|amount|price|0\.00|£/u),
    value: (t) => `${t.random.int(100, 50_000)}.${pad(t.random.int(0, 99))}`,
  },
  {
    id: "format.reference",
    test: (f) => has(f, /\breference\b|\bref\b/u),
    value: (t) => t.faker.string.alphanumeric({ length: 8, casing: "upper" }),
  },
  {
    id: "format.firstName",
    test: (f) => has(f, /first ?name|given/u),
    value: (t) => t.faker.person.firstName(),
  },
  {
    id: "format.lastName",
    test: (f) => has(f, /last ?name|surname|family/u),
    value: (t) => t.faker.person.lastName(),
  },
];

/** UK-and-English synthetic data for format rules, from the run's seed. */
export function formatTools(random: SeededRandom): FormatTools {
  const faker = new Faker({ locale: [en_GB, en, base] });
  faker.seed(random.fork());
  return { random, faker };
}

/**
 * A value for a field whose format code can recognise, or null when a model
 * should choose. Passwords are never filled ("" with the password rule).
 */
export function formatValue(
  field: FieldInfo,
  tools: FormatTools,
): { generator: string; value: string } | null {
  const rule = RULES.find((r) => r.test(field));
  if (!rule) return null;
  const value = rule.value(tools, field);
  return {
    generator: rule.id,
    value: field.maxLength ? value.slice(0, field.maxLength) : value,
  };
}

/** Format generators Jev may pick for a field code did not recognise. */
export const FORMAT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "format.sortCode": "Generate NEW synthetic UK bank sort code, like 12-34-56",
  "format.accountNumber":
    "Generate NEW synthetic 8-digit bank account number or account id",
  "format.iban": "Generate NEW synthetic UK IBAN",
  "format.niNumber":
    "Generate NEW synthetic UK National Insurance number, like QQ123456C",
  "format.reference":
    "Generate NEW synthetic 8-character uppercase reference code",
  "format.ukPostcode": "Generate NEW synthetic UK postcode",
  "format.phone": "Generate NEW synthetic UK mobile phone number",
  "format.date": "Generate NEW synthetic date as YYYY-MM-DD",
  "format.amount": "Generate NEW synthetic money amount, like 1234.56",
};

/** The value of one format generator by id, or null for an unknown id. */
export function formatById(
  id: string,
  tools: FormatTools,
  field: FieldInfo,
): string | null {
  const rule = RULES.find((r) => r.id === id);
  return rule ? rule.value(tools, field) : null;
}

/**
 * A form that is mostly filled in already edits an existing record (account
 * settings, a profile): the macro leaves those alone and only completes
 * creation forms.
 */
export function editsExistingRecord(fields: readonly FieldInfo[]): boolean {
  const filled = fields.filter((f) => !f.empty).length;
  return filled >= 2 && filled / Math.max(1, fields.length) >= 0.5;
}

/** Fields the next attempt should fill: invalid ones first, then empty ones. */
export function fieldsToFill(
  fields: readonly FieldInfo[],
  retry: boolean,
): FieldInfo[] {
  const fillable = fields.filter((f) => f.type !== "password");
  const invalid = fillable.filter((f) => f.invalid);
  if (retry && invalid.length) return invalid;
  return fillable.filter((f) => f.empty || f.invalid);
}
