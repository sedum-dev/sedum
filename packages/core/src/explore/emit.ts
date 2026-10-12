import { stringify } from "yaml";
import type { BrowserPage } from "../browser-driver.js";
import { resolveTarget } from "../locator.js";
import type { ProviderCall, Resolver } from "../provider.js";
import type { ResolvedStepTarget } from "../step-executor.js";
import { allCandidates, findByIdentity } from "./observe.js";
import { replay, type ReplayResult } from "./replay.js";
import type {
  ExploreAction,
  ExploreFailure,
  OracleOptions,
  TargetIdentity,
} from "./types.js";

export interface EmittedStep {
  readonly sentence: string;
  /**
   * matched: the sentence resolved through the locator to the recorded
   * element. ambiguous: no variant did, so the replay used the recorded
   * identity. n/a: the sentence needs no locator. unchecked: the replay
   * diverged before reaching this step.
   */
  readonly roundTrip: "matched" | "ambiguous" | "n/a" | "unchecked";
}

export interface EmittedTest {
  readonly yaml: string;
  readonly steps: readonly EmittedStep[];
  /** True when the sentence-driven replay showed the failure again. */
  readonly reproduced: boolean;
  readonly calls: readonly ProviderCall[];
}

const NOUNS: Readonly<Record<string, string>> = {
  button: "button",
  link: "link",
  checkbox: "checkbox",
  radio: "radio button",
  switch: "switch",
  tab: "tab",
  menuitem: "menu item",
  option: "option",
  combobox: "dropdown",
};

function noun(target: TargetIdentity, typing: boolean): string {
  return typing ? "field" : (NOUNS[target.role] ?? "element");
}

function region(location: string | undefined): string | undefined {
  return location?.split(" · ").at(-1)?.trim() || undefined;
}

/** Sentences for one target, from plainest to most specific. */
export function targetVariants(
  target: TargetIdentity,
  typing: boolean,
): string[] {
  const plain = `the "${target.name}" ${noun(target, typing)}`;
  const variants = [plain];
  if (target.peer) variants.push(`${plain} for ${target.peer}`);
  const place = region(target.location);
  if (place) variants.push(`${plain} in the ${place} section`);
  return variants;
}

type TargetAction = Extract<ExploreAction, { kind: "click" | "type" }>;
type PlainAction = Exclude<ExploreAction, TargetAction>;

/** A sentence that needs no locator. */
function plainSentence(action: PlainAction, urlAfter: string): string {
  switch (action.kind) {
    case "press":
      return `press ${action.key}`;
    case "scroll":
      return `scroll ${action.direction}`;
    case "wait":
      return `wait ${Math.max(1, Math.round(action.ms / 1000))} seconds`;
    case "goto":
      return `goto ${action.url}`;
    default:
      return `goto ${urlAfter}`;
  }
}

class SentenceTrip {
  readonly steps: EmittedStep[] = [];
  readonly calls: ProviderCall[] = [];
  readonly data: Record<string, string> = {};

  constructor(
    private readonly page: BrowserPage,
    private readonly resolver: Resolver,
  ) {}

  verb(action: TargetAction): string {
    if (action.kind === "click")
      return action.option === undefined
        ? "click"
        : `select ${JSON.stringify(action.option)} from`;
    const name = `value${Object.keys(this.data).length + 1}`;
    this.data[name] = action.value;
    return `type {{${name}}} into`;
  }

  /** The plainest sentence, for a step the replay never reached. */
  unchecked(action: TargetAction): EmittedStep {
    const target = targetVariants(action.target, action.kind === "type")[0]!;
    return {
      sentence: `${this.verb(action)} ${target}`,
      roundTrip: "unchecked",
    };
  }

  /** Mark the recorded element so a resolved ref can be compared to it. */
  async #mark(action: TargetAction): Promise<boolean> {
    const operation = action.kind === "click" ? "click" : "fill";
    const found = await allCandidates(this.page, operation);
    const candidates = (found?.candidates ?? []).filter(
      (c) => !c.disabled && c.editable === (action.kind === "type"),
    );
    const intended = findByIdentity(candidates, action.target);
    if (!intended) return false;
    return this.page.evaluate<boolean>(
      `(ref => { window.__sedumIntended = document.querySelector('[data-sedum-ref="' + CSS.escape(ref) + '"]'); return !!window.__sedumIntended; })(${JSON.stringify(intended.ref)})`,
    );
  }

  async #isIntended(target: ResolvedStepTarget): Promise<boolean> {
    return this.page.evaluate<boolean>(
      `(ref => !!window.__sedumIntended && window.__sedumIntended === document.querySelector('[data-sedum-ref="' + CSS.escape(ref) + '"]'))(${JSON.stringify(target.driverTarget().ref)})`,
    );
  }

  /** Try each sentence variant; keep the first that lands on the element. */
  async resolve(action: TargetAction): Promise<ResolvedStepTarget | undefined> {
    const verb = this.verb(action);
    const variants = targetVariants(action.target, action.kind === "type").map(
      (target) => `${verb} ${target}`,
    );
    for (const sentence of variants) {
      if (!(await this.#mark(action))) break;
      const result = await resolveTarget(this.page, this.resolver, {
        operation: action.kind === "click" ? "click" : "fill",
        sentence,
      });
      this.calls.push(...result.calls);
      if (
        result.kind === "resolved" &&
        (await this.#isIntended(result.target))
      ) {
        this.steps.push({ sentence, roundTrip: "matched" });
        return result.target;
      }
    }
    this.steps.push({ sentence: variants.at(-1)!, roundTrip: "ambiguous" });
    return undefined;
  }
}

const ERROR_WORDS =
  "error|failed|failure|unavailable|NaN|undefined|exception|something went wrong";
const ERROR_TEXT = new RegExp(`\\b(${ERROR_WORDS})\\b`, "iu");

/**
 * The text of the smallest visible element that shows the failure, for a
 * deterministic verify step. Null when nothing visible looks like an error.
 */
async function visibleSymptom(page: BrowserPage): Promise<string | null> {
  const text = await page
    .evaluate<string | null>(
      `((words) => {
        const pattern = new RegExp("\\\\b(" + words + ")\\\\b", "i");
        let best = null;
        for (const element of document.body.querySelectorAll("*")) {
          if (element.checkVisibility && !element.checkVisibility()) continue;
          const text = (element.innerText || "").trim();
          if (text && text.length <= 120 && pattern.test(text) && (!best || text.length < best.length)) best = text;
        }
        return best;
      })(${JSON.stringify(ERROR_WORDS)})`,
    )
    .catch(() => null);
  // An exact text check compares one line of visible text.
  const line = text?.split("\n")[0]?.trim();
  return line && !line.includes('"') && ERROR_TEXT.test(line) ? line : null;
}

function header(
  failure: ExploreFailure,
  original: number,
  kept: number,
): string {
  return [
    "# Found by `sedum explore`; shrunk from",
    `# ${original} to ${kept} actions. The exploration saw:`,
    `#   ${failure.kind}: ${failure.message.split("\n")[0]!.slice(0, 160)}`,
    "",
  ].join("\n");
}

interface EmitOptions {
  readonly startUrl: string;
  readonly actions: readonly ExploreAction[];
  readonly failure: ExploreFailure;
  readonly originalLength: number;
  readonly oracles?: OracleOptions;
}

const NO_ORACLE_NOTE =
  "# Sedum has no sentence for console or network errors yet, so this\n# test reproduces the path but cannot fail on the error itself.\n";

/** Sentences for every action, in order, once the replay has run. */
function stepsFor(
  trip: SentenceTrip,
  sentences: ReadonlyMap<number, number>,
  result: ReplayResult,
  options: EmitOptions,
): EmittedStep[] {
  const reached = result.divergedAt ?? options.actions.length;
  return options.actions.map((action, index): EmittedStep => {
    const recorded = sentences.get(index);
    if (recorded !== undefined) return trip.steps[recorded]!;
    if (action.kind === "click" || action.kind === "type")
      return trip.unchecked(action);
    return {
      sentence: plainSentence(action, result.urls[index] ?? options.startUrl),
      roundTrip: index < reached ? "n/a" : "unchecked",
    };
  });
}

function render(
  options: EmitOptions,
  data: Readonly<Record<string, string>>,
  steps: readonly EmittedStep[],
  symptom: string | null,
): string {
  const body = {
    url: options.startUrl,
    ...(Object.keys(data).length ? { data } : {}),
    steps: [
      ...steps.map((step) => step.sentence),
      ...(symptom ? [`verify the text "${symptom}" is not shown`] : []),
    ],
  };
  return (
    header(options.failure, options.originalLength, options.actions.length) +
    (symptom ? "" : NO_ORACLE_NOTE) +
    stringify(body)
  );
}

/**
 * Replay a shrunk failing trace as plain-English sentences. Each click and
 * type sentence is resolved back through Sedum's locator before it acts, and
 * kept only when it lands on the recorded element.
 */
export async function emitTest(
  page: BrowserPage,
  resolver: Resolver,
  options: EmitOptions,
): Promise<EmittedTest> {
  const trip = new SentenceTrip(page, resolver);
  const sentences = new Map<number, number>();
  const result = await replay(page, options.startUrl, options.actions, {
    ...(options.oracles ? { oracles: options.oracles } : {}),
    target: async (index, action) => {
      if (action.kind !== "click" && action.kind !== "type") return undefined;
      sentences.set(index, trip.steps.length);
      return trip.resolve(action);
    },
  });
  const steps = stepsFor(trip, sentences, result, options);
  const reproduced = result.events.some(
    (event) => event.signature === options.failure.signature,
  );
  const symptom = reproduced ? await visibleSymptom(page) : null;
  return {
    yaml: render(options, trip.data, steps, symptom),
    steps,
    reproduced,
    calls: trip.calls,
  };
}
