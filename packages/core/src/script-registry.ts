import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { BrowserContext, Page } from "playwright-core";
import type { FlowSource } from "./flow-types.js";

/**
 * The authoring surface for `*.test.ts` files. Test files and the runner may
 * load separate copies of this module (a project install and the CLI's own
 * dependency), so everything that crosses that boundary is keyed by
 * `Symbol.for` rather than by class identity.
 */
const REGISTRY = Symbol.for("sedum.script.registry");
const SECRET = Symbol.for("sedum.script.secret");

/** A value typed into the page but never shown to a model or a report. */
export interface SecretValue {
  readonly [SECRET]: () => string;
}

class Secret implements SecretValue {
  readonly #value: string;
  readonly [SECRET]: () => string;

  constructor(value: string) {
    this.#value = value;
    this[SECRET] = () => this.#value;
  }

  toString(): string {
    return "[secret]";
  }

  toJSON(): string {
    return "[secret]";
  }

  [inspect.custom](): string {
    return "[secret]";
  }
}

/** Mark a value as sensitive: it is typed, but redacted from reports and model input. */
export function secret(value: string): SecretValue {
  if (typeof value !== "string")
    throw new TypeError("secret() takes a string value.");
  return new Secret(value);
}

export function isSecret(value: unknown): value is SecretValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<SecretValue>)[SECRET] === "function"
  );
}

/** @internal The runner reads a secret's text only to type it. */
export function revealSecret(value: SecretValue): string {
  return value[SECRET]();
}

export type AiValue = string | number | boolean | SecretValue;
/** Values for `{{name}}` placeholders; keep them out of the sentence text. */
export type AiValues = Readonly<Record<string, AiValue>>;

/** Anything with a zod-style `parse`, such as `z.coerce.number()`. */
export interface Parser<T> {
  parse(input: unknown): T;
}

export interface Ai {
  /** Run one plain-English step, exactly as a YAML step sentence. */
  (sentence: string, values?: AiValues): Promise<void>;
  /** Run several steps in order; they share one values object. */
  (sentences: readonly string[], values?: AiValues): Promise<void>;
  /** Name a block of steps; every step inside is reported under the name. */
  group<T>(name: string, body: () => Promise<T> | T): Promise<T>;
  group(
    name: string,
    sentences: readonly string[],
    values?: AiValues,
  ): Promise<void>;
  /** Read the text of the element a description refers to. */
  extract(description: string): Promise<string>;
  extract<T>(description: string, parser: Parser<T>): Promise<T>;
}

export interface TestInfo {
  readonly id: string;
  readonly title: string;
  readonly file: string;
  readonly tags: readonly string[];
  /** 1 for the first attempt, 2 for the first retry, and so on. */
  readonly attempt: number;
}

export interface TestContext {
  /** The Playwright page the AI steps run on. */
  readonly page: Page;
  readonly context: BrowserContext;
  readonly ai: Ai;
  /** Configured variables and environment, as `sedum run` resolves them. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly testInfo: TestInfo;
}

export interface TestOptions {
  /** Stable identity; defaults to `<file>#<title>`. */
  readonly id?: string;
  /** Entry URL, absolute or relative to `baseUrl`. Omit to start on a blank page. */
  readonly url?: string;
  readonly tags?: readonly string[];
}

export type TestBody = (context: TestContext) => Promise<void> | void;

export interface ScriptRegistration {
  readonly title: string;
  readonly options: TestOptions;
  readonly body: TestBody;
  /** Where `test()` was called, when a stack frame could be read. */
  readonly callSite: string | undefined;
}

interface Registry {
  pending: ScriptRegistration[];
}

/** @internal */
export function scriptRegistry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[REGISTRY] ??= { pending: [] });
}

/** Declare a test. `sedum run` discovers every `test()` in a `*.test.ts` file. */
export function test(title: string, body: TestBody): void;
export function test(title: string, options: TestOptions, body: TestBody): void;
export function test(
  title: string,
  optionsOrBody: TestOptions | TestBody,
  maybeBody?: TestBody,
): void {
  const body = typeof optionsOrBody === "function" ? optionsOrBody : maybeBody;
  const options = typeof optionsOrBody === "function" ? {} : optionsOrBody;
  scriptRegistry().pending.push({
    title,
    options: options ?? {},
    body: body as TestBody,
    callSite: new Error().stack?.split("\n")[2],
  });
}

/** One stack frame, as `file:line:col`, parsed from V8's text. */
export function parseFrame(frame: string): FlowSource | undefined {
  const match = /(?:\(|at\s)([^()\s][^()]*?):(\d+):(\d+)\)?\s*$/u.exec(
    frame.trim(),
  );
  if (!match) return undefined;
  let file = match[1]!;
  if (file.startsWith("file://"))
    try {
      file = fileURLToPath(file);
    } catch {
      // Keep the URL text.
    }
  return { file, line: Number(match[2]), col: Number(match[3]) };
}

/** The innermost stack frame inside `file`, for reporting where a step was written. */
export function sourceInFile(
  stack: string | undefined,
  file: string,
): FlowSource | undefined {
  for (const frame of stack?.split("\n").slice(1) ?? []) {
    const source = parseFrame(frame);
    if (source && source.file === file) return source;
  }
  return undefined;
}
