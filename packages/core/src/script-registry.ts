import { realpathSync } from "node:fs";
import path from "node:path";
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
  /** Run a bounded goal until planner completion. Verify the outcome separately. */
  goal(goal: string, values?: AiValues): Promise<void>;
  /** Name a block of steps; every step inside is reported under the name. */
  group<T>(name: string, body: () => Promise<T> | T): Promise<T>;
  group(
    name: string,
    sentences: readonly string[],
    values?: AiValues,
  ): Promise<void>;
  /**
   * Ask whether a claim holds on the page now, to branch on what the page
   * shows. It is judged like a verify, never retried, and never fails the test.
   */
  holds(claim: string, values?: AiValues): Promise<boolean>;
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
  /**
   * The innermost stack frame in a `*.test.ts` file when `test()` ran, so a
   * test declared through a helper belongs to the test file that called it.
   * Otherwise the direct caller's frame.
   */
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
    callSite: testFileFrame(new Error().stack),
  });
}

/** A frame running a module's own top-level code: it names no function. */
const TOP_LEVEL =
  /^\s*at (?:async )?(?:Object\.<anonymous> \()?(?:file:\/\/)?[^()\s][^()]*:\d+:\d+\)?\s*$/u;

function testFileFrame(stack: string | undefined): string | undefined {
  const frames = stack?.split("\n").slice(2) ?? [];
  const inTests = frames.filter((frame) =>
    parseFrame(frame)?.file.endsWith(".test.ts"),
  );
  // A wrapper can live in another test file; the test belongs to the file
  // whose own code declared it, so prefer a module's top-level frame.
  return (
    inTests.find((frame) => TOP_LEVEL.test(frame)) ?? inTests[0] ?? frames[0]
  );
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

/**
 * One spelling per file, for comparing paths from stack frames. On Windows a
 * frame may use forward slashes, a long name for a short one (RUNNER~1 in a
 * temp dir), or another drive-letter case.
 */
export function pathKey(file: string): string {
  let resolved = path.resolve(file);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // A path that does not exist is compared as written.
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether a stack frame's path names `file`. */
export function samePath(a: string, b: string): boolean {
  return a === b || pathKey(a) === pathKey(b);
}

/** The innermost stack frame inside `file`, for reporting where a step was written. */
export function sourceInFile(
  stack: string | undefined,
  file: string,
): FlowSource | undefined {
  for (const frame of stack?.split("\n").slice(1) ?? []) {
    const source = parseFrame(frame);
    if (source && samePath(source.file, file)) return { ...source, file };
  }
  return undefined;
}
