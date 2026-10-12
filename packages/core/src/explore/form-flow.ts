import type { BrowserPage } from "../browser-driver.js";
import type { Candidate } from "../page-protocol.js";
import {
  editsExistingRecord,
  fieldsToFill,
  formatValue,
  inspectFields,
  unansweredChoices,
  type FieldInfo,
  type FormatTools,
} from "./forms.js";
import { identityOf, type Observation } from "./observe.js";
import type { ExploreAction, TargetIdentity } from "./types.js";

/** What the flow needs from the explorer: values and a safety check. */
export interface FormFlowDeps {
  readonly page: BrowserPage;
  readonly tools: FormatTools;
  /** A Faker generator for a field code cannot classify, or null. */
  readonly chooseGenerator: (
    target: TargetIdentity,
    observation: Observation,
  ) => Promise<string | null>;
  readonly generate: (generator: string) => string;
  /** False for targets judged destructive; the flow never clicks those. */
  readonly safe: (candidate: Candidate) => boolean;
}

const MAX_ATTEMPTS = 3;
const MAX_PAGES = 6;

interface Active {
  route: string;
  fields: string;
  attempts: number;
  pages: number;
}

/**
 * Completes a form the way Bombadil's custom actions do, but generically:
 * fill every empty field (code recognises formats, Jev picks the rest),
 * answer unanswered radio groups, press the form's own submit, then retry
 * only the fields the page flags as invalid, and carry on across the pages
 * of a wizard. It never edits a form that is mostly filled in already.
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
    return (
      fieldsToFill(fields, false).length > 0 && !editsExistingRecord(fields)
    );
  }

  /** Plan a first attempt on this page, or null when there is nothing to do. */
  async start(observation: Observation): Promise<ExploreAction[] | null> {
    const fields = await inspectFields(this.deps.page, observation.fills);
    if (editsExistingRecord(fields)) return null;
    this.#active = {
      route: observation.route,
      fields: fieldKey(observation),
      attempts: 1,
      pages: 1,
    };
    return this.#plan(observation, fields, false);
  }

  /**
   * After a submit: retry invalid fields on the same page, continue on the
   * next page of a wizard, or finish.
   */
  async next(observation: Observation): Promise<ExploreAction[] | null> {
    const active = this.#active;
    if (!active) return null;
    const samePage =
      observation.route === active.route &&
      fieldKey(observation) === active.fields;
    const fields = await inspectFields(
      this.deps.page,
      observation.fills,
      samePage,
    );
    const plan = samePage
      ? this.#retry(active, observation, fields)
      : this.#nextPage(active, observation, fields);
    const actions = plan ? await plan : null;
    if (!actions) this.#active = undefined;
    return actions;
  }

  #retry(
    active: Active,
    observation: Observation,
    fields: readonly FieldInfo[],
  ): Promise<ExploreAction[] | null> | null {
    if (active.attempts >= MAX_ATTEMPTS) return null;
    if (!fieldsToFill(fields, true).length) return null;
    active.attempts++;
    return this.#plan(observation, fields, true);
  }

  #nextPage(
    active: Active,
    observation: Observation,
    fields: readonly FieldInfo[],
  ): Promise<ExploreAction[] | null> | null {
    if (!worthAnotherPage(active, fields)) return null;
    Object.assign(active, {
      route: observation.route,
      fields: fieldKey(observation),
      attempts: 1,
      pages: active.pages + 1,
    });
    return this.#plan(observation, fields, false);
  }

  async #plan(
    observation: Observation,
    fields: readonly FieldInfo[],
    retry: boolean,
  ): Promise<ExploreAction[] | null> {
    const actions: ExploreAction[] = [];
    for (const field of fieldsToFill(fields, retry)) {
      const typed = await this.#type(observation, field);
      if (typed) actions.push(typed);
    }
    actions.push(...(await this.#choices(observation)));
    if (!actions.length) return null;
    actions.push(this.#submit(observation, fields));
    return actions;
  }

  async #type(
    observation: Observation,
    field: FieldInfo,
  ): Promise<ExploreAction | null> {
    const candidate = observation.fills.find((c) => c.ref === field.ref);
    if (!candidate) return null;
    const target = identityOf(observation.fills, candidate, observation.url);
    const formatted = formatValue(field, this.deps.tools);
    if (formatted?.generator === "format.password") return null;
    const generator =
      formatted?.generator ??
      (await this.deps.chooseGenerator(target, observation)) ??
      "faker.lorem.words";
    const value = formatted?.value ?? this.deps.generate(generator);
    return {
      kind: "type",
      target,
      value: field.maxLength ? value.slice(0, field.maxLength) : value,
      source: { kind: "faker", generator },
    };
  }

  /** Answer radio groups nobody answered, with their first option. */
  async #choices(observation: Observation): Promise<ExploreAction[]> {
    const labels = await unansweredChoices(this.deps.page);
    return labels.flatMap((label) => {
      const candidate = observation.clicks.find(
        (c) => c.role === "radio" && c.name === label && this.deps.safe(c),
      );
      return candidate
        ? [
            {
              kind: "click",
              target: identityOf(
                observation.clicks,
                candidate,
                observation.url,
              ),
            } as const,
          ]
        : [];
    });
  }

  /** The form's own submit control when it is safe, else Enter. */
  #submit(
    observation: Observation,
    fields: readonly FieldInfo[],
  ): ExploreAction {
    const name = fields.find((f) => f.submit)?.submit;
    const candidate = name
      ? observation.clicks.find((c) => c.name === name && this.deps.safe(c))
      : undefined;
    return candidate
      ? {
          kind: "click",
          target: identityOf(observation.clicks, candidate, observation.url),
        }
      : { kind: "press", key: "Enter" };
  }
}

/** A next wizard page within budget, with empty fields, not an edit form. */
function worthAnotherPage(
  active: Active,
  fields: readonly FieldInfo[],
): boolean {
  if (active.pages >= MAX_PAGES) return false;
  return fieldsToFill(fields, false).length > 0 && !editsExistingRecord(fields);
}

/** The set of fields on a page: a new set means a new page of a wizard. */
function fieldKey(observation: Observation): string {
  return observation.fills.map((c) => `${c.role}|${c.name}`).join(";");
}
