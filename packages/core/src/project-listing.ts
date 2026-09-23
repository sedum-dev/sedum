import path from "node:path";
import { findIdentityCollisions } from "./flow-loader.js";
import type { FlowDiagnostic, ParsedFlowResult } from "./flow-types.js";
import { compareDiagnostics } from "./project-validation.js";

export interface ListedTest {
  readonly id: string;
  readonly idSource: "explicit" | "path";
  /** Repository-relative with `/` separators. */
  readonly file: string;
  readonly description: string | null;
  readonly tags: readonly string[];
}

export interface ListedDiagnostic {
  readonly severity: FlowDiagnostic["severity"];
  readonly code: string;
  readonly line: number;
  readonly col: number;
  readonly message: string;
  readonly fix: string;
}

export interface InvalidListEntry {
  readonly file: string;
  readonly diagnostics: readonly ListedDiagnostic[];
}

export interface TestListing {
  readonly tests: readonly ListedTest[];
  readonly invalid: readonly InvalidListEntry[];
}

/** Repository-relative path with `/` separators on every OS. */
export function displayPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Shape parsed tests for `sedum list`. A file that failed format, or whose id
 * collides with an earlier test, is listed as invalid instead of as a test.
 */
export function listTests(
  parsed: readonly {
    readonly file: string;
    readonly result: ParsedFlowResult;
  }[],
  options: { readonly repoRoot: string },
): TestListing {
  const collisions = findIdentityCollisions(
    parsed.flatMap((entry) => (entry.result.value ? [entry.result.value] : [])),
  );
  const tests: ListedTest[] = [];
  const invalid: InvalidListEntry[] = [];
  const ordered = [...parsed].sort((a, b) => {
    const left = displayPath(options.repoRoot, a.file);
    const right = displayPath(options.repoRoot, b.file);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const { file, result } of ordered) {
    const flow = result.value;
    const own = [
      ...result.diagnostics.filter((item) => item.severity === "error"),
      ...collisions.filter((item) => item.source.file === file),
    ];
    const relative = displayPath(options.repoRoot, file);
    if (!flow || own.length) {
      invalid.push({
        file: relative,
        diagnostics: [...own].sort(compareDiagnostics).map((item) => ({
          severity: item.severity,
          code: item.code,
          line: item.source.line,
          col: item.source.col,
          message: item.message,
          fix: item.fix,
        })),
      });
      continue;
    }
    tests.push({
      id: flow.identity,
      idSource: flow.explicitId === undefined ? "path" : "explicit",
      file: relative,
      description: flow.description ?? null,
      tags: [...flow.tags],
    });
  }
  return { tests, invalid };
}
