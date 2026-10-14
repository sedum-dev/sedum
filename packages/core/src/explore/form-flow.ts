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
  newSuccess,
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
export type FormPurpose =
  "create" | "record" | "settings" | "search" | "signin";

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
  /**
   * A submit did nothing visible; for each field that holds a default zero,
   * whether it needs a real value.
   */
  needsValue(
    observation: Observation,
    labels: readonly string[],
  ): Promise<readonly boolean[]>;
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
  /** The form being completed, when a page has several (a search, a chat). */
  group?: string | undefined;
  route: string;
  fields: readonly string[];
  attempts: number;
  pages: number;
  /** Custom dropdowns still to open this attempt. */
  queue: Dropdown[];
  /** The dropdown just opened, and the targets shown before it opened. */
  opened?: Opened | undefined;
  /** The option just clicked, to check it took (menus re-render). */
  picked?: Picked | undefined;
  /** Dropdowns already picked again: never a third time. */
  retried: Set<string>;
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
  /** What Jev says the form does; only a "create" form gets a password. */
  purpose?: FormPurpose | undefined;
  /** One new password per form, so a confirmation field matches. */
  password?: string | undefined;
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

/** An option clicked in a custom dropdown, once or twice. */
interface Picked {
  readonly dropdown: Dropdown;
  readonly name: string;
  readonly before: ReadonlySet<string>;
  readonly again: boolean;
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
    return this.#worthStarting(observation, oneForm(fields));
  }

  /** Plan a first attempt on this page, or null when there is nothing to do. */
  async start(observation: Observation): Promise<ExploreAction[] | null> {
    const fields = oneForm(
      await inspectFields(this.deps.page, observation.fills),
    );
    if (!(await this.#worthStarting(observation, fields))) return null;
    this.#stack = [];
    this.#active = this.#fresh(observation, 1, fields);
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

  #fresh(
    observation: Observation,
    pages: number,
    fields: readonly FieldInfo[],
  ): Active {
    return {
      group: fields[0]?.group,
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
      retried: new Set(),
    };
  }

  /**
   * Never a settings form. A form Jev says creates something is completed
   * even when the app pre-filled it (a new plan copies the client's
   * details); otherwise one mostly filled in already edits a record.
   */
  async #worthStarting(
    observation: Observation,
    fields: readonly FieldInfo[],
  ): Promise<boolean> {
    const purpose = await this.#purpose(observation);
    // A sign-in form needs real credentials; settings change the account.
    if (purpose === "settings" || purpose === "signin") return false;
    const empty = fieldsToFill(fields, false).length > 0;
    if (purpose === "create") return empty || continues(observation, fields);
    return empty && !editsExistingRecord(fields);
  }

  /** The fields of the form being completed. */
  async #fields(observation: Observation): Promise<FieldInfo[]> {
    const fields = await inspectFields(this.deps.page, observation.fills);
    return inGroup(fields, this.#active?.group);
  }

  #purpose(observation: Observation): Promise<FormPurpose | undefined> {
    const labels = observation.fills.map((c) => c.name);
    return this.deps.judge.purpose(observation, labels);
  }

  async #notSettings(observation: Observation): Promise<boolean> {
    return (await this.#purpose(observation)) !== "settings";
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
      fillsOf(observation, fields),
    );
    active.proxies = new Set(
      dropdowns.filter((d) => d.typeahead).map((d) => d.shown),
    );
    active.purpose ??= await this.#purpose(observation);
    const planned = errors.length
      ? errors
      : [
          ...fieldsToFill(fields, false),
          ...this.#newPasswords(active, fields),
        ].map((field) => ({ field }));
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

  /**
   * A sign-up form needs a password the macro makes up; a sign-in form
   * would need a real one, so it gets none.
   */
  #newPasswords(active: Active, fields: readonly FieldInfo[]): FieldInfo[] {
    if (active.purpose !== "create") return [];
    return fields.filter((f) => f.type === "password" && f.empty);
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
    const again = await this.#repick(observation, active);
    if (again) return again;
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
    const label = dropdown.label || dropdown.shown;
    const want = options[await this.#optionIndex(observation, label, options)]!;
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
    const fields = await this.#fields(observation);
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
    // A search form never waits for a sub-form; its button is busy instead.
    if ((await this.#purpose(observation)) === "search") return null;
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
    const fields = oneForm(
      await inspectFields(this.deps.page, observation.fills),
    );
    this.#active = {
      ...this.#fresh(observation, active.pages, fields),
      nested: true,
    };
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
    const names = options.map((c) => c.name);
    const label = dropdown.label || dropdown.shown;
    const option =
      typed ?? options[await this.#optionIndex(observation, label, names)]!;
    const again = active.retried.has(dropdownKey(dropdown));
    active.picked = { dropdown, name: option.name, before, again };
    return [click(observation, option)];
  }

  /**
   * A dropdown that still shows its placeholder after a pick: the menu
   * re-rendered under the click. Click the option again while the menu is
   * open, or reopen the dropdown, once.
   */
  async #repick(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    const picked = active.picked;
    active.picked = undefined;
    if (!picked || picked.again) return null;
    const dropdowns = await unansweredDropdowns(
      this.deps.page,
      fillsOf(observation, await this.#fields(observation)),
    );
    const { dropdown } = picked;
    const still = dropdowns.some(
      (d) =>
        !d.native && d.shown === dropdown.shown && d.label === dropdown.label,
    );
    if (!still) return null;
    active.retried.add(dropdownKey(dropdown));
    const option = observation.clicks.find(
      (c) => c.name === picked.name && !picked.before.has(targetSignature(c)),
    );
    if (!option) {
      active.queue.unshift(dropdown);
      return null;
    }
    active.picked = { ...picked, again: true };
    return [click(observation, option)];
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
      const index = await this.#optionIndex(
        observation,
        dropdown.label || dropdown.shown,
        options,
      );
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
    label: string,
    options: readonly string[],
  ): Promise<number> {
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
      sameFields(fieldKey(observation), active.fields);
    return samePage
      ? this.#retryHere(observation, active)
      : this.#movedOn(observation, active);
  }

  /** A sub-form that closed is done (its parent carries on); else a next page. */
  async #movedOn(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    if (active.nested) return null;
    const fields = oneForm(
      await inspectFields(this.deps.page, observation.fills),
    );
    return this.#nextPage(observation, fields);
  }

  /** Fix what the page reports on the same page, within the attempt budget. */
  async #retryHere(
    observation: Observation,
    active: Active,
  ): Promise<ExploreAction[] | null> {
    if (active.attempts >= MAX_ATTEMPTS) return null;
    const fields = inGroup(
      await inspectFields(this.deps.page, observation.fills, true),
      active.group,
    );
    const after = await formLines(this.deps.page, observation.fills);
    const lines = newErrorLines(active.baseline ?? [], after);
    const fixes = lines.length
      ? await this.#fixes(observation, fields, lines)
      : await this.#silent(observation, fields, active, after);
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

  /**
   * The submit did nothing visible and said nothing: fields marked invalid,
   * else default zeros Jev says need a real value. A success message means
   * the submit went through.
   */
  async #silent(
    observation: Observation,
    fields: readonly FieldInfo[],
    active: Active,
    after: readonly string[],
  ): Promise<Fill[]> {
    const invalid = await this.#fixes(observation, fields, []);
    if (invalid.length || newSuccess(active.baseline ?? [], after))
      return invalid;
    const zeros = fields.filter((f) => f.zero);
    if (!zeros.length) return [];
    const labels = zeros.map((f) => labelOf(observation, f));
    const needed = await this.deps.judge.needsValue(observation, labels);
    const error = "The form did not submit while this held a default 0";
    return zeros.filter((_, i) => needed[i]).map((field) => ({ field, error }));
  }

  /** Fields to fill again: those flagged invalid, and those errors name. */
  async #fixes(
    observation: Observation,
    fields: readonly FieldInfo[],
    lines: readonly string[],
  ): Promise<Fill[]> {
    const labels = fields.map((f) => labelOf(observation, f));
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
    this.#active = this.#fresh(observation, active.pages + 1, fields);
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
    // A field named after its value ("0") is described by its hints instead.
    const described = { ...target, name: labelOf(observation, field) };
    const value = await this.#value(observation, described, fill);
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
    if (formatted?.generator === "format.password") return this.#password();
    if (formatted?.value)
      return { generator: formatted.generator, text: formatted.value };
    // A default zero the form refused stays a number, such as a fee.
    if (field.zero)
      return {
        generator: "format.number",
        text: String(this.deps.tools.random.int(1, 100)),
      };
    const generator =
      (await this.deps.chooseGenerator(target, observation, error)) ??
      "faker.lorem.words";
    return { generator, text: this.deps.generate(generator, field) };
  }

  /** The form's new password; only creation forms plan password fields. */
  #password(): { generator: string; text: string } | null {
    const active = this.#active!;
    if (active.purpose !== "create") return null;
    active.password ??= `${this.deps.tools.faker.internet.password({ length: 12 })}Aa1!`;
    return { generator: "format.newPassword", text: active.password };
  }

  /** Answer radio groups nobody answered, with an option Jev picks. */
  async #choices(observation: Observation): Promise<ExploreAction[]> {
    const actions: ExploreAction[] = [];
    const radios = observation.clicks.filter(
      (c) => c.role === "radio" && this.deps.safe(c),
    );
    for (const group of await unansweredChoices(this.deps.page)) {
      const label = group.title || group.options[0]!;
      const index = await this.#optionIndex(observation, label, group.options);
      const candidate = matching(radios, group.options[index]!);
      if (candidate) actions.push(click(observation, candidate));
    }
    return actions;
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

/** The field's name, or its hints when the name is only a value ("0"). */
function labelOf(observation: Observation, field: FieldInfo): string {
  const name = observation.fills.find((c) => c.ref === field.ref)?.name ?? "";
  return /\p{L}/u.test(name) ? name : field.hints || name;
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

/** Buttons that move a wizard on, up to its last page ("See plan"). */
const CONTINUE =
  /^(save (&|and) )?(continue|next|finish|done|complete|see)\b.{0,24}$/iu;

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

function dropdownKey(dropdown: Dropdown): string {
  return `${dropdown.label}|${dropdown.shown}|${dropdown.nth}`;
}

/** Fields of one form: a page with a search box and a chat has two. */
function inGroup(
  fields: readonly FieldInfo[],
  group: string | undefined,
): FieldInfo[] {
  return group === undefined
    ? [...fields]
    : fields.filter((f) => f.group === group);
}

/** The form on the page with the most fields left to fill. */
function oneForm(fields: readonly FieldInfo[]): FieldInfo[] {
  const empty = new Map<string | undefined, number>();
  for (const field of fieldsToFill(fields, false))
    empty.set(field.group, (empty.get(field.group) ?? 0) + 1);
  const busiest = [...empty.entries()].sort((a, b) => b[1] - a[1])[0];
  return busiest ? inGroup(fields, busiest[0]) : [...fields];
}

/** The fill candidates of these fields, to find the form around them. */
function fillsOf(
  observation: Observation,
  fields: readonly FieldInfo[],
): Candidate[] {
  const refs = new Set(fields.map((f) => f.ref));
  return observation.fills.filter((c) => refs.has(c.ref));
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

/** The fields on a page: a new set means a new page of a wizard. */
function fieldKey(observation: Observation): string[] {
  return observation.fills.map((c) => `${c.role}|${c.name}`);
}

/**
 * The same fields, though a name may lose its placeholder once filled in
 * ("Account name Enter account name" becomes "Account name").
 */
function sameFields(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    a.every((key, i) => key.startsWith(b[i]!) || b[i]!.startsWith(key))
  );
}
