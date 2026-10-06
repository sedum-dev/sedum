import type { FlowDiagnostic, FlowSource } from "./flow-types.js";
import { callExtent as measureCallExtent } from "./script-sentences/call-extent.js";
import {
  scanImportBindings as findImportBindings,
  scanLocalImports as findLocalImports,
} from "./script-sentences/imports.js";
import {
  scanScriptSentences as scanSentences,
  tokenize as tokenizeScript,
} from "./script-sentences/scanner.js";

/** A literal step sentence written in a `*.test.ts` file. */
export interface ScriptSentence {
  readonly text: string;
  readonly source: FlowSource;
  /** The sentence is a claim passed to `ai.holds`, not a general step. */
  readonly check?: true;
}

export interface ScriptSentenceScan {
  readonly sentences: readonly ScriptSentence[];
  /** Static diagnostics, including run-time shapes that cannot be checked. */
  readonly warnings: readonly FlowDiagnostic[];
  /** Parameter names of the functions this file declares, by position. */
  readonly functions: ReadonlyMap<string, readonly string[]>;
  /**
   * `f(ai)` calls to a function this file does not declare. Validation
   * resolves them through imports: the parameter must be named `ai`.
   */
  readonly helperCalls: readonly HelperCall[];
}

export interface HelperCall {
  readonly callee: string;
  readonly position: number;
  readonly source: FlowSource;
  /**
   * `ai`: the test's ai itself, so the parameter must be named `ai`.
   * `context`: the test's context or `{ ai }`, so the helper must be one
   * validation reads.
   */
  readonly passes: "ai" | "context";
}

type Token =
  | {
      readonly kind: "ident" | "punct";
      readonly value: string;
      readonly line: number;
      readonly col: number;
    }
  | {
      readonly kind: "string";
      readonly value: string;
      /** A template literal with `${}` has no single value. */
      readonly dynamic: boolean;
      readonly line: number;
      readonly col: number;
    };

/** A small JavaScript lexer: enough to find string arguments of `ai` calls. */
export function tokenize(source: string): Token[] {
  return tokenizeScript(source);
}

/**
 * Find the literal sentences passed to `ai(...)`, `ai([...])`,
 * `ai.group(name, [...])`, and `ai.holds(...)`. A sentence built with `${}` or
 * `+` is reported as a warning: it defeats the classification cache and cannot
 * be checked before a run. `ai.extract` takes a description, not a step, so it
 * is skipped.
 */
export function scanScriptSentences(
  source: string,
  file: string,
): ScriptSentenceScan {
  return scanSentences(source, file);
}

/**
 * Relative module specifiers a file imports, such as `./support/login.js`.
 * Validation follows them to check the sentences in shared helpers.
 */
export function scanLocalImports(source: string): readonly string[] {
  return findLocalImports(source);
}

export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
}

/** Named and default imports: `import login, { a, b as c } from "./x.js"`. */
export function scanImportBindings(source: string): readonly ImportBinding[] {
  return findImportBindings(source);
}

/**
 * The lines of the call expression that starts on `line`, such as a whole
 * `test("…", async () => { … })`, so a helper declared elsewhere in the file
 * is not mistaken for part of a test. The outermost call on the line wins.
 */
export function callExtent(
  source: string,
  line: number,
): { readonly start: number; readonly end: number } | undefined {
  return measureCallExtent(source, line);
}
