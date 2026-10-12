import type { ProviderCall } from "../provider.js";
import { routeTemplate } from "./archive.js";
import type { FormJudge, FormPurpose } from "./form-flow.js";
import type { Observation } from "./observe.js";
import type { ExplorationAdvisor, ExploreDecisionRequest } from "./types.js";

const PAGE_TEXT_LIMIT = 3_000;
const OPTION_LIMIT = 60;

const PURPOSES: Readonly<Record<FormPurpose, string>> = {
  create:
    "Creates something new: a client, an account, a plan, an order, a message, a record",
  record:
    "Fills in or updates the details of one existing item, such as one client's details or one plan's steps",
  settings:
    "Changes settings or configuration for the whole account, firm, organisation or team: branding, fees, preferences, integrations, permissions",
  search: "Only searches, filters or looks something up",
};

/** A target that adds the item a form still needs, such as "Add an account". */
const ADD = /^\+?\s*(add|new|create)\b/iu;

const SETTINGS_ROUTE =
  /settings|preferences|config|branding|profile|billing|permissions/iu;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(optional\)|\*/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The longest label an error line names, such as "Account ID is invalid". */
export function labelInLine(
  line: string,
  labels: readonly string[],
): number | null {
  const text = ` ${normalize(line)} `;
  let best: number | null = null;
  labels.forEach((label, index) => {
    const name = normalize(label);
    if (name.length < 3 || !text.includes(` ${name} `)) return;
    if (best === null || name.length > normalize(labels[best]!).length)
      best = index;
  });
  return best;
}

/** Rules alone: heuristic mode, and guided mode when a call fails. */
export const RULE_JUDGE: FormJudge = {
  purpose: (observation) =>
    Promise.resolve(
      SETTINGS_ROUTE.test(observation.route) ? "settings" : undefined,
    ),
  option: () => Promise.resolve(null),
  prerequisite: (_observation, _submit, targets) => {
    const index = targets.findIndex((name) => ADD.test(name));
    return Promise.resolve(index < 0 ? null : index);
  },
  needsValue: (_observation, labels) => Promise.resolve(labels.map(() => true)),
  errorLabels: (_observation, lines, labels) =>
    Promise.resolve(lines.map((line) => labelInLine(line, labels))),
};

export interface JevJudgeDeps {
  readonly advisor: ExplorationAdvisor;
  readonly callOptions: () => { signal?: AbortSignal };
  /** Record a call's cost and latency, or a failure. */
  readonly recorded: (call: ProviderCall, ms: number) => void;
  readonly failed: (error: unknown) => undefined;
}

/**
 * Jev answers the form questions code cannot: what a form does, which
 * dropdown option to choose, and which field an error line is about. Each
 * is a closed choice, cached per form, so a form costs a call or two.
 */
export class JevJudge implements FormJudge {
  readonly #cache = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: JevJudgeDeps) {}

  purpose(
    observation: Observation,
    labels: readonly string[],
  ): Promise<FormPurpose | undefined> {
    const key = `purpose|${routeTemplate(observation.route)}|${labels.join(";")}`;
    return this.#once(key, async () => {
      const answers = await this.#decide(
        observation,
        {
          route: observation.route,
          fields: labels.join(", ").slice(0, 600),
        },
        {
          purpose: {
            question:
              "What does submitting the main form on `page` (with the fields in `subject.fields`) do?",
            choices: PURPOSES,
          },
        },
      );
      const purpose = answers?.purpose as FormPurpose | undefined;
      return purpose ?? RULE_JUDGE.purpose(observation, labels);
    });
  }

  option(
    observation: Observation,
    dropdown: string,
    options: readonly string[],
  ): Promise<number | null> {
    const shown = options.slice(0, OPTION_LIMIT);
    const key = `option|${routeTemplate(observation.route)}|${dropdown}|${shown.join(";")}`;
    return this.#once(key, async () => {
      const choices = Object.fromEntries(
        shown.map((name, index) => [`o${index}`, name]),
      );
      const answers = await this.#decide(
        observation,
        { dropdown },
        {
          option: {
            question:
              "Which option would a realistic user choose for `subject.dropdown` (a dropdown or a group of choices) to fill in this form validly?",
            rules:
              "Choose a real option, never a heading, a placeholder or an action such as adding a new option.",
            choices,
          },
        },
      );
      return answers ? Number(answers.option!.slice(1)) : null;
    });
  }

  prerequisite(
    observation: Observation,
    submit: string,
    targets: readonly string[],
  ): Promise<number | null> {
    const key = `prerequisite|${routeTemplate(observation.route)}|${submit}|${targets.join(";")}`;
    return this.#once(key, async () => {
      const choices: Record<string, string> = {
        none: "None of these targets enables it",
      };
      targets.forEach((name, index) => (choices[`t${index}`] = name));
      const answers = await this.#decide(
        observation,
        { submit },
        {
          target: {
            question:
              "The button `subject.submit` is disabled until the form has what it needs. Which target must the user use first?",
            rules:
              "Usually a target that adds the missing item, such as an 'Add …' button. Never a link to another page, a destructive action, or a way to leave the form.",
            choices,
          },
        },
      );
      const answer = answers?.target;
      if (answer === undefined)
        return RULE_JUDGE.prerequisite(observation, submit, targets);
      return answer.startsWith("t") ? Number(answer.slice(1)) : null;
    });
  }

  async needsValue(
    observation: Observation,
    labels: readonly string[],
  ): Promise<readonly boolean[]> {
    const questions: ExploreDecisionRequest["questions"] = Object.fromEntries(
      labels.map((_, index) => [
        `field${index}`,
        {
          question: `The form did not submit and showed no error. The field \`subject.field${index}\` holds 0. Does it need a real value for the form to be accepted?`,
          rules:
            "A balance, amount or quantity the item cannot have at zero needs a value; an optional fee, rate or count of zero does not.",
          choices: { yes: "Needs a real value", no: "Zero is acceptable" },
        },
      ]),
    );
    const subject = Object.fromEntries(
      labels.map((label, index) => [`field${index}`, label || "(no label)"]),
    );
    const answers = await this.#decide(observation, subject, questions);
    if (!answers) return RULE_JUDGE.needsValue(observation, labels);
    return labels.map((_, index) => answers[`field${index}`] === "yes");
  }

  async errorLabels(
    observation: Observation,
    lines: readonly string[],
    labels: readonly string[],
  ): Promise<readonly (number | null)[]> {
    const byCode = lines.map((line) => labelInLine(line, labels));
    const open = byCode.flatMap((found, index) =>
      found === null ? [index] : [],
    );
    if (!open.length || labels.length < 1) return byCode;
    const choices: Record<string, string> = { none: "No field in the list" };
    labels.forEach(
      (label, index) => (choices[`f${index}`] = label || "(no label)"),
    );
    const questions: ExploreDecisionRequest["questions"] = Object.fromEntries(
      open.map((line) => [
        `line${line}`,
        {
          question: `Which form field is the error message \`subject.error${line}\` about?`,
          choices,
        },
      ]),
    );
    const subject = Object.fromEntries(
      open.map((line) => [`error${line}`, lines[line]!]),
    );
    const answers = await this.#decide(observation, subject, questions);
    return byCode.map((found, index) => {
      const answer = answers?.[`line${index}`];
      return (
        found ?? (answer?.startsWith("f") ? Number(answer.slice(1)) : null)
      );
    });
  }

  #once<T>(key: string, ask: () => Promise<T>): Promise<T> {
    if (!this.#cache.has(key)) this.#cache.set(key, ask());
    return this.#cache.get(key) as Promise<T>;
  }

  /** One call for a set of questions; their chosen ids, or null on failure. */
  async #decide(
    observation: Observation,
    subject: Record<string, string>,
    questions: ExploreDecisionRequest["questions"],
  ): Promise<Record<string, string> | null> {
    const decide = this.deps.advisor.decide?.bind(this.deps.advisor);
    if (!decide) return null;
    const started = performance.now();
    const decision = await decide(
      {
        page: observation.text.slice(0, PAGE_TEXT_LIMIT),
        subject,
        questions,
      },
      this.deps.callOptions(),
    ).catch((error: unknown) => this.deps.failed(error));
    if (!decision) return null;
    this.deps.recorded(decision.call, Math.round(performance.now() - started));
    return Object.fromEntries(
      Object.entries(decision.answers).map(([id, answer]) => [
        id,
        answer.choice,
      ]),
    );
  }
}
