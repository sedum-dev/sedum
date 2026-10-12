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
  /**
   * The submit `submit` is disabled: the index of the target that must be
   * used first (such as "Add an account"), or null for none.
   */
  prerequisite(
    observation: Observation,
    submit: string,
    targets: readonly string[],
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
/** Times one form may open a sub-form to enable its submit. */
const MAX_UNLOCKS = 2;
/** Sub-forms inside sub-forms, at most. */
const MAX_DEPTH = 2;
const TARGET_LIMIT = 60;

interface Active {
  route: string;
  fields: string;
  attempts: number;
  pages: number;
  /** Custom dropdowns still to open this attempt. */
  queue: Dropdown[];
  /** The dropdown just opened, and the targets shown before it opened. */
  opened?: Opened | undefined;
  /** Names of type-ahead inputs: chosen through their list, never typed. */
  proxies: ReadonlySet<string>;
  /** Fields typed into this attempt. */
  typed: Set<string>;
  /** Submitted this attempt; the next step checks what the page says. */
  submitted: boolean;
  /** The form's lines before its first submit: errors are lines it lacked. */
  baseline?: readonly string[] | undefined;
  /** A sub-form opened from a form whose submit was disabled. */
  nested: boolean;
  unlocks: number;
  /** A target was used to enable the submit; what the page held before. */
  unlocking?: Unlocking | undefined;
}

interface Unlocking {
  readonly route: string;
  readonly fills: ReadonlySet<string>;
}

/** The form's submit: an action, disabled (by name), or none usable. */
type Submit =
  | { readonly kind: "act"; readonly action: ExploreAction }
  | { readonly kind: "disabled"; readonly name: string }
  | { readonly kind: "none" };

/** A dropdown just opened, the targets before it, and the option typed. */
interface Opened {
  readonly dropdown: Dropdown;
  readonly before: ReadonlySet<string>;
  readonly want?: string;
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
  /** Forms waiting for the sub-form they opened. */
  #stack: Active[] = [];

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
    if (!fieldsToFill(fields, false).length) return null;
    if (!(await this.#allowed(observation, fields))) return null;
    this.#stack = [];
    this.#active = this.#fresh(observation, 1);
    return this.#finish(await this.#attempt(observation, fields, []));
  }

  /** The next part of the plan once the previous part has run. */
  async next(observation: Observation): Promise<ExploreAction[] | null> {
    const active = this.#active;
    if (!active) return null;
    const actions = await this.#step(observation, active);
    if (actions?.length) return actions;
    return this.#resume(observation);
  }

  #step(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    if (active.unlocking) return this.#enterSub(observation, active);
    if (active.opened) return this.#pick(observation, active);
    return active.submitted
      ? this.#afterSubmit(observation, active)
      : this.#advance(observation, active);
  }

  /** This form is done: carry on with the form that opened it, if any. */
  async #resume(observation: Observation): Promise<ExploreAction[] | null> {
    const parent = this.#stack.pop();
    this.#active = parent;
    if (!parent) return null;
    // The sub-form may have added rows or fields to the parent form.
    parent.fields = fieldKey(observation);
    parent.submitted = false;
    return this.next(observation);
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
      proxies: new Set(),
      nested: false,
      unlocks: 0,
    };
  }

  async #allowed(
    observation: Observation,
    fields: readonly FieldInfo[],
  ): Promise<boolean> {
    if (editsExistingRecord(fields)) return false;
    return this.#notSettings(observation);
  }

  async #notSettings(observation: Observation): Promise<boolean> {
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
    const dropdowns = await unansweredDropdowns(
      this.deps.page,
      observation.fills,
    );
    active.proxies = new Set(
      dropdowns.filter((d) => d.typeahead).map((d) => d.shown),
    );
    const planned = errors.length
      ? errors
      : fieldsToFill(fields, false).map((field) => ({ field }));
    const fills = this.#typeable(observation, planned);
    const actions = [
      ...(await this.#typeAll(observation, fills)),
      ...(await this.#choices(observation)),
      ...(await this.#natives(observation, dropdowns)),
    ];
    active.queue = dropdowns.filter((d) => !d.native);
    const rest = await this.#advance(observation, active);
    return rest ? [...actions, ...rest] : null;
  }

  /** Leave out type-ahead inputs: their list chooses the value. */
  #typeable(observation: Observation, fills: readonly Fill[]): Fill[] {
    const proxies = this.#active!.proxies;
    return fills.filter((fill) => {
      const name = observation.fills.find(
        (c) => c.ref === fill.field.ref,
      )?.name;
      return !name || !proxies.has(name);
    });
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
      const opened = dropdown.typeahead
        ? await this.#search(observation, dropdown)
        : this.#open(observation, dropdown);
      if (!opened) continue;
      active.opened = opened.opened;
      return [opened.action];
    }
    return this.#submitAll(observation, active);
  }

  #open(
    observation: Observation,
    dropdown: Dropdown,
  ): { opened: Opened; action: ExploreAction } | null {
    const candidate = this.#usable(observation, dropdown);
    if (!candidate) return null;
    const opened = { dropdown, before: shown(observation) };
    return { opened, action: click(observation, candidate) };
  }

  /** Type a chosen option into a type-ahead input; its result is clicked next. */
  async #search(
    observation: Observation,
    dropdown: Dropdown,
  ): Promise<{ opened: Opened; action: ExploreAction } | null> {
    const input = observation.fills.filter((c) => c.name === dropdown.shown)[
      dropdown.nth
    ];
    const options = dropdown.options ?? [];
    if (!input || !options.length) return null;
    const want =
      options[await this.#optionIndex(observation, dropdown, options)]!;
    const opened = { dropdown, before: shown(observation), want };
    return {
      opened,
      action: {
        kind: "type",
        target: identityOf(observation.fills, input, observation.url),
        value: want,
        source: { kind: "faker", generator: "format.option" },
      },
    };
  }

  /** Fields that appeared after a choice (conditional fields), then submit. */
  async #submitAll(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const fields = await inspectFields(this.deps.page, observation.fills);
    const extra = this.#typeable(
      observation,
      fieldsToFill(fields, false)
        .filter((f) => !active.typed.has(f.ref))
        .map((field) => ({ field })),
    );
    const actions = await this.#typeAll(observation, extra);
    const submit = this.#submit(observation, fields);
    if (submit.kind === "none") return null;
    // Typing may enable a disabled submit; only then look for a sub-form.
    if (submit.kind === "disabled")
      return actions.length
        ? actions
        : this.#unlock(observation, active, submit.name);
    active.baseline ??= await formLines(this.deps.page, observation.fills);
    active.submitted = true;
    return [...actions, submit.action];
  }

  /** Use the target Jev says must come first, such as "Add an account". */
  async #unlock(
    observation: Observation,
    active: Active,
    submit: string,
  ): Promise<ExploreAction[] | null> {
    if (active.unlocks >= MAX_UNLOCKS || this.#stack.length >= MAX_DEPTH)
      return null;
    active.unlocks++;
    const targets = observation.clicks
      .filter((c) => c.name && !c.disabled && this.deps.safe(c))
      .slice(0, TARGET_LIMIT);
    const names = targets.map((c) => c.name);
    const index = await this.deps.judge.prerequisite(
      observation,
      submit,
      names,
    );
    if (index === null) return null;
    active.unlocking = {
      route: observation.route,
      fills: new Set(observation.fills.map((c) => targetSignature(c))),
    };
    return [click(observation, targets[index]!)];
  }

  /** Complete the sub-form the unlocking target opened, as its own form. */
  async #enterSub(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const before = active.unlocking!;
    active.unlocking = undefined;
    const appeared = observation.fills.some(
      (c) => !before.fills.has(targetSignature(c)),
    );
    // No new fields (a checkbox, say): try the submit again.
    if (!appeared && observation.route === before.route)
      return this.#advance(observation, active);
    this.#stack.push(active);
    this.#active = { ...this.#fresh(observation, active.pages), nested: true };
    const fields = await inspectFields(this.deps.page, observation.fills);
    if (!fieldsToFill(fields, false).length) return null;
    if (!(await this.#notSettings(observation))) return null;
    return this.#attempt(observation, fields, []);
  }

  /** Choose one of the targets that appeared when the dropdown opened. */
  async #pick(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const { dropdown, before, want } = active.opened!;
    active.opened = undefined;
    const options = observation.clicks.filter(
      (c) =>
        !before.has(targetSignature(c)) &&
        c.name &&
        !PLACEHOLDER.test(c.name) &&
        this.deps.safe(c),
    );
    if (!options.length) return [{ kind: "press", key: "Escape" }];
    const typed = want ? matching(options, want) : undefined;
    if (typed) return [click(observation, typed)];
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
    // A sub-form that closed or moved on is done; its parent carries on.
    if (!samePage)
      return active.nested ? null : this.#nextPage(observation, fields);
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
    // The macro started this record, so values the app filled in by
    // default do not make the next page an edit form.
    if (active.pages >= MAX_PAGES) return null;
    if (!fieldsToFill(fields, false).length && !continues(observation, fields))
      return null;
    if (!(await this.#notSettings(observation))) return null;
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
   * The form's own submit control (or the page's Continue button), Enter
   * when a form has none in view, and none when its submit is unsafe: Enter
   * would submit it anyway. A disabled submit waits for a sub-form.
   */
  #submit(observation: Observation, fields: readonly FieldInfo[]): Submit {
    const name = submitName(observation, fields);
    const named = observation.clicks.filter((c) => name && c.name === name);
    if (!named.length) return noButton(observation, fields, name);
    // A nav link can share the button's name ("Search"); prefer the button.
    const buttons = named.filter((c) => !c.signals.href);
    const pool = buttons.length ? buttons : named;
    if (!pool.every((c) => this.deps.safe(c))) return { kind: "none" };
    return { kind: "act", action: click(observation, pool[0]!) };
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

/** The result whose name is the typed option, or contains it. */
function matching(
  options: readonly Candidate[],
  want: string,
): Candidate | undefined {
  const norm = (text: string) =>
    text.toLowerCase().replace(/\s+/gu, " ").trim();
  return (
    options.find((c) => norm(c.name) === norm(want)) ??
    options.find((c) => norm(c.name).includes(norm(want)))
  );
}

/** No enabled submit: one that waits (disabled), Enter in a form, or none. */
function noButton(
  observation: Observation,
  fields: readonly FieldInfo[],
  name: string,
): Submit {
  if (name && observation.disabled.some((c) => c.name === name))
    return { kind: "disabled", name };
  return fields.length
    ? { kind: "act", action: { kind: "press", key: "Enter" } }
    : { kind: "none" };
}

const CONTINUE = /continue|next/iu;

/** The submit of the fields' form, else the page's Continue button. */
function submitName(
  observation: Observation,
  fields: readonly FieldInfo[],
): string {
  const own = fields.find((f) => f.submit)?.submit;
  if (own) return own;
  const next = [...observation.clicks, ...observation.disabled].find(
    (c) => !c.signals.href && CONTINUE.test(c.name),
  );
  return next?.name ?? "";
}

/** A wizard page with nothing empty that still asks to continue. */
function continues(
  observation: Observation,
  fields: readonly FieldInfo[],
): boolean {
  return CONTINUE.test(submitName(observation, fields));
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
