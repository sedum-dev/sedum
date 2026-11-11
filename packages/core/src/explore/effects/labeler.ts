import type { GoalChoice } from "../../goal-runner.js";
import type { Candidate } from "../../page-protocol.js";
import type { Observation } from "../observe.js";
import type { ExploreDecisionRequest } from "../types.js";
import { foldName, pageTemplate } from "./template.js";
import type { ControlClass } from "./view.js";
import {
  ACCEPT,
  DESTRUCTIVE,
  EFFECTS,
  FIELD_ROLES,
  GATES,
  type Effect,
  type FieldRole,
  type Gate,
} from "./vocabulary.js";

/** One Jev call of closed questions; null when it failed. */
export type Decide = (
  request: ExploreDecisionRequest,
) => Promise<Readonly<Record<string, GoalChoice>> | null>;

/** The provider takes at most this many questions per call. */
const QUESTION_LIMIT = 60;
/** Choice descriptions repeat per question: keep a call well under the body limit. */
const BYTE_LIMIT = 40_000;
const PAGE_TEXT = 1_200;
const GATE_TEXT = 1_500;
const NAME_LIMIT = 80;

type Questions = ExploreDecisionRequest["questions"];

/** One thing to ask about and how to store its answers. */
interface Item {
  readonly id: string;
  readonly subject: string;
  readonly questions: Questions;
  readonly store: (answers: Readonly<Record<string, GoalChoice>>) => void;
}

function confident(answer: GoalChoice | undefined): string | undefined {
  if (!answer) return undefined;
  const confidence =
    answer.confidence ?? answer.probabilities[answer.choice] ?? 0;
  return confidence >= ACCEPT ? answer.choice : undefined;
}

function describeControl(control: ControlClass): string {
  const first = control.members[0]!;
  const parts = [`${first.role} "${first.name.slice(0, NAME_LIMIT)}"`];
  if (first.location) parts.push(`in ${first.location}`);
  if (first.signals.href)
    parts.push(`links to ${first.signals.href.slice(0, 100)}`);
  if (first.peers[0]) parts.push(`beside "${first.peers[0].slice(0, 60)}"`);
  if (control.record)
    parts.push(
      `one of ${control.members.length} like it, e.g. ${control.members
        .slice(0, 3)
        .map((c) => `"${c.name.slice(0, 40)}"`)
        .join(", ")}`,
    );
  if (control.options?.length)
    parts.push(
      `options: ${control.options.slice(0, 12).join(" | ").slice(0, 200)}`,
    );
  return parts.join("; ");
}

/** The cache key of a field: its label and type. */
export function fieldKey(fill: Candidate): string {
  return `${foldName(fill.name)}|${fill.inputType}`;
}

/**
 * Labels for the effects planner, learned once per control and field
 * wherever they appear: only unseen things are asked, in one call per page
 * (more when a page holds more than one call's questions).
 */
export class Labeler {
  readonly #effects = new Map<string, Effect>();
  readonly #destructive = new Map<string, number>();
  readonly #fields = new Map<string, FieldRole>();

  constructor(
    private readonly decide: Decide,
    private readonly askDestructive: boolean,
  ) {}

  effectOf = (control: ControlClass): Effect | undefined =>
    this.#effects.get(control.labelKey);

  /** Probability that the control is destructive, when asked. */
  destructive(control: ControlClass): number | undefined {
    return this.#destructive.get(control.labelKey);
  }

  fieldRole(fill: Candidate): FieldRole {
    return this.#fields.get(fieldKey(fill)) ?? "other";
  }

  /** Ask about every control and field on the page that has no label yet. */
  async label(
    observation: Observation,
    controls: readonly ControlClass[],
  ): Promise<void> {
    const items = [
      ...this.#controlItems(controls),
      ...this.#fieldItems(observation.fills),
    ];
    for (const chunk of chunks(items)) await this.#ask(observation, chunk);
  }

  /** A forward step changed nothing: what must happen first? */
  async gate(observation: Observation, action: string): Promise<Gate> {
    const answers = await this.decide({
      page: observation.text.slice(0, GATE_TEXT),
      subject: {
        route: pageTemplate(observation.url),
        action: action.slice(0, NAME_LIMIT),
      },
      questions: {
        gate: {
          question:
            "The user activated `subject.action` and nothing visible moved forward. What must happen first?",
          choices: GATES,
        },
      },
    });
    return (confident(answers?.gate) as Gate | undefined) ?? "nothing";
  }

  #controlItems(controls: readonly ControlClass[]): Item[] {
    const unseen = controls.filter((c) => !this.#effects.has(c.labelKey));
    return unseen.map((control, index) => {
      const id = `t${index}`;
      const questions: Record<string, Questions[string]> = {
        [`eff_${id}`]: {
          question: `What does activating \`subject.${id}\` do?`,
          choices: EFFECTS,
        },
      };
      if (this.askDestructive)
        questions[`dst_${id}`] = {
          question: `Would activating \`subject.${id}\` perform a destructive or irreversible action?`,
          rules:
            "If it confirms or proceeds in a dialog that asks a question, judge the action the dialog describes.",
          choices: DESTRUCTIVE,
        };
      return {
        id,
        subject: describeControl(control),
        questions,
        store: (answers) => {
          const effect = confident(answers[`eff_${id}`]) as Effect | undefined;
          this.#effects.set(control.labelKey, effect ?? "other");
          const danger = answers[`dst_${id}`]?.probabilities.yes;
          if (danger !== undefined)
            this.#destructive.set(control.labelKey, danger);
        },
      };
    });
  }

  #fieldItems(fills: readonly Candidate[]): Item[] {
    const unseen = new Map<string, Candidate>();
    for (const fill of fills)
      if (!this.#fields.has(fieldKey(fill))) unseen.set(fieldKey(fill), fill);
    return [...unseen.entries()].map(([key, fill], index) => {
      const id = `f${index}`;
      return {
        id,
        subject: `${fill.role} "${fill.name.slice(0, NAME_LIMIT)}" of type ${fill.inputType || "text"}`,
        questions: {
          [`field_${id}`]: {
            question: `What does the field \`subject.${id}\` ask for?`,
            choices: FIELD_ROLES,
          },
        },
        store: (answers) =>
          this.#fields.set(
            key,
            (confident(answers[`field_${id}`]) as FieldRole | undefined) ??
              "other",
          ),
      };
    });
  }

  async #ask(observation: Observation, items: readonly Item[]): Promise<void> {
    const subject: Record<string, string> = {
      route: pageTemplate(observation.url),
      title: observation.title.slice(0, NAME_LIMIT),
    };
    let questions: Questions = {};
    for (const item of items) {
      subject[item.id] = item.subject;
      questions = { ...questions, ...item.questions };
    }
    const answers = await this.decide({
      page: observation.text.slice(0, PAGE_TEXT),
      subject,
      questions,
    });
    // A failed call is asked again on the next page that shows these.
    if (answers) for (const item of items) item.store(answers);
  }
}

/** Items in groups that fit one call's question limit. */
function chunks(items: readonly Item[]): Item[][] {
  const out: Item[][] = [];
  let current: Item[] = [];
  let count = 0;
  let bytes = 0;
  for (const item of items) {
    const size = Object.keys(item.questions).length;
    const weight = JSON.stringify(item.questions).length + item.subject.length;
    const full = count + size > QUESTION_LIMIT || bytes + weight > BYTE_LIMIT;
    if (current.length && full) {
      out.push(current);
      current = [];
      count = 0;
      bytes = 0;
    }
    current.push(item);
    count += size;
    bytes += weight;
  }
  if (current.length) out.push(current);
  return out;
}
