import { Command, InvalidArgumentError } from "commander";
import { validAffectedGlob } from "./affected-paths.js";
import {
  MAX_PARALLEL,
  parseParallel,
  type ParallelRequest,
} from "./run-pool.js";

/** The untrusted text supplied for one CLI option. */
class RawOptionText {
  constructor(readonly value: string) {}

  get trimmed(): string {
    return this.value.trim();
  }

  get number(): number {
    return Number(this.value);
  }

  get projectRelativeGlob(): boolean {
    return [
      this.trimmed.length > 0,
      !this.value.startsWith("/"),
      !/^[A-Za-z]:[/\\]/u.test(this.value),
      !this.value.split(/[/\\]/u).includes(".."),
    ].every(Boolean);
  }
}

interface ScalarParser<Result> {
  parse(text: RawOptionText): Result;
}

interface Collector<Result> {
  parse(text: RawOptionText, previous: Result): Result;
}

class CommanderScalarParser<Result> {
  readonly callback: (value: string) => Result;

  constructor(parser: ScalarParser<Result>) {
    this.callback = (value: string): Result =>
      parser.parse(new RawOptionText(value));
  }
}

class CommanderCollector<Result> {
  readonly callback: (value: string, previous: Result) => Result;

  constructor(parser: Collector<Result>) {
    this.callback = (value: string, previous: Result): Result =>
      parser.parse(new RawOptionText(value), previous);
  }
}

function invalid(message: string): never {
  throw new InvalidArgumentError(message);
}

class OriginCollector implements Collector<readonly string[]> {
  parse(text: RawOptionText, previous: readonly string[]): string[] {
    try {
      return [...previous, new URL(text.value).origin];
    } catch {
      return invalid(
        `Invalid origin ${JSON.stringify(text.value)}. Use an absolute URL such as https://example.com.`,
      );
    }
  }
}

class ValueCollector implements Collector<readonly string[]> {
  parse(text: RawOptionText, previous: readonly string[]): string[] {
    if (!text.trimmed) invalid("Value must not be blank.");
    return [...previous, text.value];
  }
}

const REPORTERS = ["list", "steps", "terminal", "json", "markdown", "junit"];

class ReporterCollector implements Collector<readonly string[]> {
  parse(text: RawOptionText, previous: readonly string[]): string[] {
    const selected = [...previous];
    for (const item of text.value.split(",").map((name) => name.trim())) {
      if (!REPORTERS.includes(item))
        invalid(
          `Unknown reporter ${JSON.stringify(item)}. Use list or steps for terminal output, or terminal, json, markdown, or junit.`,
        );
      if (!selected.includes(item)) selected.push(item);
    }
    return selected;
  }
}

class GlobCollector implements Collector<readonly string[]> {
  parse(text: RawOptionText, previous: readonly string[]): string[] {
    if (!text.projectRelativeGlob)
      invalid("Glob must be a nonempty project-relative path without '..'.");
    return [...previous, text.value];
  }
}

class LabelCollector implements Collector<readonly string[]> {
  parse(text: RawOptionText, previous: readonly string[]): string[] {
    const labels = text.value.split(",").map((item) => item.trim());
    if (labels.some((item) => !item))
      invalid("Labels must be nonempty comma-separated tags.");
    return [...previous, ...labels];
  }
}

interface NumberRange {
  readonly minimum: number;
  readonly maximum: number;
  readonly minimumInclusive: boolean;
  readonly safeInteger: boolean;
  readonly digitsOnly: boolean;
  readonly nonblank: boolean;
  readonly error: string;
}

class RangedNumberParser implements ScalarParser<number> {
  constructor(private readonly range: NumberRange) {}

  parse(text: RawOptionText): number {
    const { number } = text;
    const minimumSatisfied = this.range.minimumInclusive
      ? number >= this.range.minimum
      : number > this.range.minimum;
    const valid = [
      Number.isFinite(number),
      minimumSatisfied,
      number <= this.range.maximum,
      !this.range.safeInteger || Number.isSafeInteger(number),
      !this.range.digitsOnly || /^[1-9]\d*$/u.test(text.value),
      !this.range.nonblank || text.trimmed.length > 0,
    ];
    return valid.every(Boolean) ? number : invalid(this.range.error);
  }
}

class ParallelParser implements ScalarParser<ParallelRequest> {
  parse(text: RawOptionText): ParallelRequest {
    return (
      parseParallel(text.value) ??
      invalid(`Expected auto or an integer from 1 to ${MAX_PARALLEL}.`)
    );
  }
}

function scalar<Result>(
  parser: ScalarParser<Result>,
): (value: string) => Result {
  return new CommanderScalarParser(parser).callback;
}

function collector<Result>(
  parser: Collector<Result>,
): (value: string, previous: Result) => Result {
  return new CommanderCollector(parser).callback;
}

function rangedNumber(range: NumberRange): (value: string) => number {
  return scalar(new RangedNumberParser(range));
}

export const collectOrigin = collector(new OriginCollector());
export const collectValue = collector(new ValueCollector());
/** `--reporter` is repeatable and also takes a comma list, e.g. junit,markdown. */
export const collectReporter = collector(new ReporterCollector());
export const collectGlob = collector(new GlobCollector());
export function collectAffectedGlob(
  value: string,
  previous: readonly string[],
): string[] {
  if (!validAffectedGlob(value))
    invalid("Affected ignore must be a valid repository-relative POSIX glob.");
  return [...previous, value];
}
export const collectLabels = collector(new LabelCollector());

export const nonnegativeInteger = rangedNumber({
  minimum: 0,
  maximum: 20,
  minimumInclusive: true,
  safeInteger: true,
  digitsOnly: false,
  nonblank: false,
  error: "Expected an integer from 0 to 20.",
});

export const nonnegativeSlow = rangedNumber({
  minimum: 0,
  maximum: 30_000,
  minimumInclusive: true,
  safeInteger: true,
  digitsOnly: false,
  nonblank: false,
  error: "Expected milliseconds from 0 to 30000.",
});

export const parallelValue = scalar(new ParallelParser());

export function positiveCount(maximum: number): (value: string) => number {
  return rangedNumber({
    minimum: 1,
    maximum,
    minimumInclusive: true,
    safeInteger: true,
    digitsOnly: true,
    nonblank: false,
    error: `Expected an integer from 1 to ${maximum}.`,
  });
}

export const positiveMinutes = rangedNumber({
  minimum: 0,
  maximum: 1440,
  minimumInclusive: false,
  safeInteger: false,
  digitsOnly: false,
  nonblank: false,
  error: "Expected minutes greater than 0 and at most 1440.",
});

export const relevanceThreshold = rangedNumber({
  minimum: 0,
  maximum: 1,
  minimumInclusive: true,
  safeInteger: false,
  digitsOnly: false,
  nonblank: true,
  error: "Expected a probability from 0 to 1.",
});

export function commandHelp(
  command: Command,
  writeErr: (value: string) => void,
): void {
  command.outputHelp({ error: true });
  const commandPath: string[] = [];
  for (
    let current: Command | null = command;
    current;
    current = current.parent
  ) {
    commandPath.unshift(current.name());
  }
  writeErr(
    `Fix: run \`${commandPath.join(" ")} --help\` and provide a command.\n`,
  );
}
