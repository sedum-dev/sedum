import { Faker, base, en, en_GB } from "@faker-js/faker";
import type { BrowserPage } from "../browser-driver.js";
import type { Candidate } from "../page-protocol.js";
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
    for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
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
const has = (field: FieldInfo, pattern: RegExp) => pattern.test(field.hints);

const RULES: readonly FormatRule[] = [
  {
    id: "format.password",
    test: (f) => f.type === "password",
    value: () => "",
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
    id: "format.ukPostcode",
    test: (f) => has(f, /post ?code/u),
    value: (t) => t.faker.location.zipCode(),
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
