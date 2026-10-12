import type { BrowserPage } from "../browser-driver.js";
import type { Candidate } from "../page-protocol.js";
import { targetSignature } from "./actions.js";
import {
  editsExistingRecord,
  fieldsToFill,
  formatValue,
  formLines,
  inspectFields,
  newErrorLines,
  PLACEHOLDER,
  unansweredChoices,
  unansweredDropdowns,
  type Dropdown,
  type FieldInfo,
  type FormatTools,
} from "./forms.js";
import { identityOf, type Observation } from "./observe.js";
import { valueForError } from "./pattern-sample.js";
import type { ExploreAction, TargetIdentity } from "./types.js";

/** What submitting a form does, as far as the macro cares. */
export type FormPurpose = "create" | "record" | "settings" | "search";

/** The questions code cannot answer: Jev in guided mode, rules otherwise. */
export interface FormJudge {
  /** Settings forms change the whole account; the macro leaves them alone. */
  purpose(
    observation: Observation,
    labels: readonly string[],
  ): Promise<FormPurpose | undefined>;
  /** The index of the option to choose, or null to choose at random. */
  option(
    observation: Observation,
    dropdown: string,
    options: readonly string[],
  ): Promise<number | null>;
  /** For each error line, the index of the label it is about, or null. */
  errorLabels(
    observation: Observation,
    lines: readonly string[],
    labels: readonly string[],
  ): Promise<readonly (number | null)[]>;
}

/** What the flow needs from the explorer: values, safety and judgement. */
export interface FormFlowDeps {
  readonly page: BrowserPage;
  readonly tools: FormatTools;
  /** A generator for a field code cannot classify (or that failed), or null. */
  readonly chooseGenerator: (
    target: TargetIdentity,
    observation: Observation,
    error?: string,
  ) => Promise<string | null>;
  readonly generate: (generator: string, field: FieldInfo) => string;
  /** False for targets judged destructive; the flow never clicks those. */
  readonly safe: (candidate: Candidate) => boolean;
  readonly judge: FormJudge;
}

const MAX_ATTEMPTS = 3;
const MAX_PAGES = 6;

interface Active {
  route: string;
  fields: string;
  attempts: number;
  pages: number;
  /** Custom dropdowns still to open this attempt. */
  queue: Dropdown[];
  /** The dropdown just opened, and the targets shown before it opened. */
  opened?: { dropdown: Dropdown; before: ReadonlySet<string> } | undefined;
  /** Fields typed into this attempt. */
  typed: Set<string>;
  /** Submitted this attempt; the next step checks what the page says. */
  submitted: boolean;
  /** The form's lines before its first submit: errors are lines it lacked. */
  baseline?: readonly string[] | undefined;
}

/** One planned value: the field, and the error it must fix, if any. */
interface Fill {
  readonly field: FieldInfo;
  readonly error?: string;
}

/**
 * Completes a form the way Bombadil's custom actions do, but generically:
 * fill every empty field (code recognises formats, Jev picks the rest),
 * answer radio groups and dropdowns, press the form's own submit, then fix
 * what the page reports, beside a field or in a summary box, and carry on
 * across the pages of a wizard. Each phase plans only its next actions,
 * because a dropdown's options exist only once it is open. It never
 * completes a settings form or one mostly filled in already.
 */
export class FormFlow {
  #active: Active | undefined;

  constructor(private readonly deps: FormFlowDeps) {}

  get active(): boolean {
    return this.#active !== undefined;
  }

  /** Whether this page offers a form worth completing. */
  async offers(observation: Observation): Promise<boolean> {
    const fields = await inspectFields(this.deps.page, observation.fills);
    if (!fieldsToFill(fields, false).length) return false;
    return this.#allowed(observation, fields);
  }

  /** Plan a first attempt on this page, or null when there is nothing to do. */
  async start(observation: Observation): Promise<ExploreAction[] | null> {
    const fields = await inspectFields(this.deps.page, observation.fills);
    if (!(await this.#allowed(observation, fields))) return null;
    this.#active = this.#fresh(observation, 1);
    return this.#finish(await this.#attempt(observation, fields, []));
  }

  /** The next part of the plan once the previous part has run. */
  async next(observation: Observation): Promise<ExploreAction[] | null> {
    const active = this.#active;
    if (!active) return null;
    const actions = active.opened
      ? await this.#pick(observation, active)
      : active.submitted
        ? await this.#afterSubmit(observation, active)
        : await this.#advance(observation, active);
    return this.#finish(actions);
  }

  #finish(actions: ExploreAction[] | null): ExploreAction[] | null {
    if (!actions?.length) this.#active = undefined;
    return actions?.length ? actions : null;
  }

  #fresh(observation: Observation, pages: number): Active {
    return {
      route: observation.route,
      fields: fieldKey(observation),
      attempts: 1,
      pages,
      queue: [],
      typed: new Set(),
      submitted: false,
    };
  }

  async #allowed(
    observation: Observation,
    fields: readonly FieldInfo[],
  ): Promise<boolean> {
    if (editsExistingRecord(fields)) return false;
    const labels = observation.fills.map((c) => c.name);
    const purpose = await this.deps.judge.purpose(observation, labels);
    return purpose !== "settings";
  }

  /**
   * Type the planned values and answer radios and native dropdowns, then
   * open the first custom dropdown or submit.
   */
  async #attempt(
    observation: Observation,
    fields: readonly FieldInfo[],
    errors: readonly Fill[],
  ): Promise<ExploreAction[] | null> {
    const active = this.#active!;
    const fills = errors.length
      ? errors
      : fieldsToFill(fields, false).map((field) => ({ field }));
    const dropdowns = await unansweredDropdowns(
      this.deps.page,
      observation.fills,
    );
    const actions = [
      ...(await this.#typeAll(observation, fills)),
      ...(await this.#choices(observation)),
      ...(await this.#natives(observation, dropdowns)),
    ];
    active.queue = dropdowns.filter((d) => !d.native);
    const rest = await this.#advance(observation, active);
    return rest ? [...actions, ...rest] : null;
  }

  async #typeAll(
    observation: Observation,
    fills: readonly Fill[],
  ): Promise<ExploreAction[]> {
    const actions: ExploreAction[] = [];
    for (const fill of fills) {
      const typed = await this.#type(observation, fill);
      if (!typed) continue;
      actions.push(typed);
      this.#active!.typed.add(fill.field.ref);
    }
    return actions;
  }

  /** Open the next custom dropdown, or type new fields and submit. */
  async #advance(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    while (active.queue.length) {
      const dropdown = active.queue.shift()!;
      const candidate = this.#usable(observation, dropdown);
      if (!candidate) continue;
      active.opened = { dropdown, before: shown(observation) };
      return [click(observation, candidate)];
    }
    return this.#submitAll(observation, active);
  }

  /** Fields that appeared after a choice (conditional fields), then submit. */
  async #submitAll(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const fields = await inspectFields(this.deps.page, observation.fills);
    const extra = fieldsToFill(fields, false)
      .filter((f) => !active.typed.has(f.ref))
      .map((field) => ({ field }));
    const actions = await this.#typeAll(observation, extra);
    const submit = this.#submit(observation, fields);
    if (!submit) return null;
    active.baseline ??= await formLines(this.deps.page, observation.fills);
    active.submitted = true;
    return [...actions, submit];
  }

  /** Choose one of the targets that appeared when the dropdown opened. */
  async #pick(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const { dropdown, before } = active.opened!;
    active.opened = undefined;
    const options = observation.clicks.filter(
      (c) =>
        !before.has(targetSignature(c)) &&
        c.name &&
        !PLACEHOLDER.test(c.name) &&
        this.deps.safe(c),
    );
    if (!options.length) return [{ kind: "press", key: "Escape" }];
    const names = options.map((c) => c.name);
    const chosen = await this.#optionIndex(observation, dropdown, names);
    return [click(observation, options[chosen]!)];
  }

  /** Native selects choose their option in one click. */
  async #natives(
    observation: Observation,
    dropdowns: readonly Dropdown[],
  ): Promise<ExploreAction[]> {
    const actions: ExploreAction[] = [];
    for (const dropdown of dropdowns) {
      const options = dropdown.native ? (dropdown.options ?? []) : [];
      const candidate = options.length
        ? this.#usable(observation, dropdown)
        : undefined;
      if (!candidate) continue;
      const index = await this.#optionIndex(observation, dropdown, options);
      actions.push({
        ...click(observation, candidate),
        option: options[index]!,
      });
    }
    return actions;
  }

  /** The dropdown's click candidate, when it is safe to click. */
  #usable(observation: Observation, dropdown: Dropdown): Candidate | undefined {
    const candidate = candidateOf(observation, dropdown);
    return candidate && this.deps.safe(candidate) ? candidate : undefined;
  }

  /** Jev's pick in guided mode, else a random option. */
  async #optionIndex(
    observation: Observation,
    dropdown: Dropdown,
    options: readonly string[],
  ): Promise<number> {
    const label = dropdown.label || dropdown.shown;
    const judged = await this.deps.judge.option(observation, label, options);
    return judged ?? this.deps.tools.random.int(0, options.length - 1);
  }

  /**
   * After a submit: fix what the page reports on the same page, continue on
   * the next page of a wizard, or finish.
   */
  async #afterSubmit(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const samePage =
      observation.route === active.route &&
      fieldKey(observation) === active.fields;
    const fields = await inspectFields(
      this.deps.page,
      observation.fills,
      samePage,
    );
    if (!samePage) return this.#nextPage(observation, fields);
    if (active.attempts >= MAX_ATTEMPTS) return null;
    const lines = newErrorLines(
      active.baseline ?? [],
      await formLines(this.deps.page, observation.fills),
    );
    const fixes = await this.#fixes(observation, fields, lines);
    // Nothing flagged: the submit went through, or the page says nothing.
    if (!fixes.length && !lines.length) return null;
    this.#active = {
      ...active,
      attempts: active.attempts + 1,
      typed: new Set(),
      submitted: false,
    };
    return this.#attempt(observation, fields, fixes);
  }

  /** Fields to fill again: those flagged invalid, and those errors name. */
  async #fixes(
    observation: Observation,
    fields: readonly FieldInfo[],
    lines: readonly string[],
  ): Promise<Fill[]> {
    const labels = fields.map(
      (f) => observation.fills.find((c) => c.ref === f.ref)?.name ?? "",
    );
    const named = lines.length
      ? await this.deps.judge.errorLabels(observation, lines, labels)
      : [];
    const errorOf = new Map<string, string>();
    named.forEach((index, line) => {
      if (index !== null) errorOf.set(fields[index]!.ref, lines[line]!);
    });
    return fields
      .filter((f) => f.type !== "password")
      .filter((f) => f.invalid || errorOf.has(f.ref))
      .map((field) => ({
        field,
        error: errorOf.get(field.ref) ?? "The page marked this field invalid",
      }));
  }

  async #nextPage(
    observation: Observation,
    fields: readonly FieldInfo[],
  ): Promise<ExploreAction[] | null> {
    const active = this.#active!;
    if (active.pages >= MAX_PAGES || !fieldsToFill(fields, false).length)
      return null;
    if (!(await this.#allowed(observation, fields))) return null;
    this.#active = this.#fresh(observation, active.pages + 1);
    return this.#attempt(observation, fields, []);
  }

  async #type(
    observation: Observation,
    fill: Fill,
  ): Promise<ExploreAction | null> {
    const { field } = fill;
    const candidate = observation.fills.find((c) => c.ref === field.ref);
    if (!candidate) return null;
    const target = identityOf(observation.fills, candidate, observation.url);
    const value = await this.#value(observation, target, fill);
    if (value === null) return null;
    return {
      kind: "type",
      target,
      value: field.maxLength
        ? value.text.slice(0, field.maxLength)
        : value.text,
      source: { kind: "faker", generator: value.generator },
    };
  }

  /**
   * The format an error states ("must be 6 digits"), else a format code
   * recognises, else a generator Jev picks knowing the error.
   */
  async #value(
    observation: Observation,
    target: TargetIdentity,
    { field, error }: Fill,
  ): Promise<{ generator: string; text: string } | null> {
    const stated = error ? valueForError(error, this.deps.tools.random) : null;
    if (stated) return { generator: "format.stated", text: stated };
    // A recognised format stays right on a retry; only its value changes.
    const formatted = formatValue(field, this.deps.tools);
    if (formatted?.generator === "format.password") return null;
    if (formatted?.value)
      return { generator: formatted.generator, text: formatted.value };
    const generator =
      (await this.deps.chooseGenerator(target, observation, error)) ??
      "faker.lorem.words";
    return { generator, text: this.deps.generate(generator, field) };
  }

  /** Answer radio groups nobody answered, with their first option. */
  async #choices(observation: Observation): Promise<ExploreAction[]> {
    const labels = await unansweredChoices(this.deps.page);
    return labels.flatMap((label) => {
      const candidate = observation.clicks.find(
        (c) => c.role === "radio" && c.name === label && this.deps.safe(c),
      );
      return candidate ? [click(observation, candidate)] : [];
    });
  }

  /**
   * The form's own submit control, Enter when the form has none in view,
   * and nothing when its submit is unsafe: Enter would submit it anyway.
   */
  #submit(
    observation: Observation,
    fields: readonly FieldInfo[],
  ): ExploreAction | null {
    const name = fields.find((f) => f.submit)?.submit;
    const named = observation.clicks.filter((c) => name && c.name === name);
    if (!named.length) return { kind: "press", key: "Enter" };
    // A nav link can share the button's name ("Search"); prefer the button.
    const buttons = named.filter((c) => !c.signals.href);
    const pool = buttons.length ? buttons : named;
    if (!pool.every((c) => this.deps.safe(c))) return null;
    return click(observation, pool[0]!);
  }
}

function click(
  observation: Observation,
  candidate: Candidate,
): Extract<ExploreAction, { kind: "click" }> {
  return {
    kind: "click",
    target: identityOf(observation.clicks, candidate, observation.url),
  };
}

/** The click candidate of a dropdown the page script found. */
function candidateOf(
  observation: Observation,
  dropdown: Dropdown,
): Candidate | undefined {
  if (dropdown.native) {
    const selects = observation.clicks.filter((c) => c.tag === "select");
    return (
      selects.find((c) => dropdown.label && c.name === dropdown.label) ??
      selects[dropdown.nth]
    );
  }
  const shown = observation.clicks.filter(
    (c) => c.name === dropdown.shown && !c.signals.href,
  );
  return shown[dropdown.nth];
}

/** The targets on screen, to tell which ones a dropdown added. */
function shown(observation: Observation): Set<string> {
  return new Set(observation.clicks.map((c) => targetSignature(c)));
}

/** The set of fields on a page: a new set means a new page of a wizard. */
function fieldKey(observation: Observation): string {
  return observation.fills.map((c) => `${c.role}|${c.name}`).join(";");
}
