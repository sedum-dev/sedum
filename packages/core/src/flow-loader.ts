import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseFlowSource } from "./flow-loader/flow-parser.js";
import { parseModuleSource } from "./flow-loader/module-parser.js";
import { walkSuiteFiles } from "./project-discovery.js";
import { addDiagnostic, compareDiagnostics } from "./flow-loader/context.js";
import type {
  FlowDefinition,
  FlowDiagnostic,
  FlowSource,
  FlowValidationResult,
  ParsedFlowResult,
  ParsedModuleResult,
  ValidationInput,
} from "./flow-types.js";

export interface ParseFlowOptions {
  /** Needed for stable, repo-relative identity when `id` is absent. */
  readonly repoRoot: string;
  /** Validation may warn about URL resolution without opening a network connection. */
  readonly baseUrl?: string;
  /** Run selection forbids an explicit file symlink at the point of opening. */
  readonly rejectSymlinks?: boolean;
}

export function parseFlow(
  source: string,
  file: string,
  options: ParseFlowOptions,
): ParsedFlowResult {
  return parseFlowSource(source, file, options);
}

export function validateFlows(
  inputs: readonly ValidationInput[],
  options: ParseFlowOptions,
): FlowValidationResult {
  const files = inputs.map((input) =>
    parseFlow(input.source, input.path, options),
  );
  const diagnostics = files.flatMap((file) => [...file.diagnostics]);
  const flows = files.flatMap((file) => (file.value ? [file.value] : []));
  diagnostics.push(...findIdentityCollisions(flows));
  diagnostics.sort(compareDiagnostics);
  return {
    files,
    diagnostics,
    coverage: {
      format: diagnostics.some((item) => item.severity === "error")
        ? "failed"
        : "passed",
      steps: "not_checked",
      modules: files.some((file) => file.coverage.modules === "not_checked")
        ? "not_checked"
        : "not_needed",
    },
  };
}

function byFile(left: FlowDefinition, right: FlowDefinition): number {
  return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
}

function pathIdentityOwners(
  flows: readonly FlowDefinition[],
): Map<string, FlowDefinition> {
  const owners = new Map<string, FlowDefinition>();
  for (const flow of flows)
    if (flow.explicitId === undefined) owners.set(flow.identity, flow);
  return owners;
}

function duplicateExplicitId(
  flow: FlowDefinition,
  source: FlowSource,
  previous: FlowSource,
  diagnostics: FlowDiagnostic[],
): void {
  addDiagnostic(
    diagnostics,
    "error",
    "duplicate_id",
    source,
    `Duplicate explicit id \`${flow.explicitId}\`; first used at ${previous.file}:${previous.line}:${previous.col}.`,
    "Give each test a unique explicit id or remove id to use the file path.",
  );
}

function collidingPathIdentity(
  flow: FlowDefinition,
  source: FlowSource,
  pathOwner: FlowDefinition,
  diagnostics: FlowDiagnostic[],
): void {
  addDiagnostic(
    diagnostics,
    "error",
    "duplicate_id",
    source,
    `Explicit id \`${flow.explicitId}\` equals the path identity of ${pathOwner.file}.`,
    "Choose an id that is not another test's repository-relative path.",
  );
}

/**
 * Report tests that share an identity: two explicit ids, or an explicit id
 * equal to another test's path identity. The later file (by path) is reported.
 */
export function findIdentityCollisions(
  flows: readonly FlowDefinition[],
): readonly FlowDiagnostic[] {
  const diagnostics: FlowDiagnostic[] = [];
  const sorted = [...flows].sort(byFile);
  const pathIdentities = pathIdentityOwners(sorted);
  const explicit = new Map<string, FlowSource>();
  for (const flow of sorted) {
    if (flow.explicitId === undefined) continue;
    const source = flow.idSource ?? { file: flow.file, line: 1, col: 1 };
    const previous = explicit.get(flow.explicitId);
    const pathOwner = pathIdentities.get(flow.explicitId);
    if (previous) duplicateExplicitId(flow, source, previous, diagnostics);
    else if (pathOwner)
      collidingPathIdentity(flow, source, pathOwner, diagnostics);
    else explicit.set(flow.explicitId, source);
  }
  return diagnostics.sort(compareDiagnostics);
}

/** Parse a strict reusable module without granting it test-level fields. */
export function parseModule(source: string, file: string): ParsedModuleResult {
  return parseModuleSource(source, file);
}

/** Sorted `*.test.yaml` files, skipping `node_modules` and dot-directories. */
export async function discoverFlowFiles(
  directory: string,
): Promise<readonly string[]> {
  return walkSuiteFiles(directory, [".test.yaml"]);
}

function unreadableResult(file: string): ParsedFlowResult {
  return {
    diagnostics: [
      {
        severity: "error",
        code: "unreadable_file",
        source: { file, line: 1, col: 1 },
        message: "Could not read this test file.",
        fix: "Check the path and file permissions.",
      },
    ],
    coverage: {
      format: "failed",
      steps: "not_checked",
      modules: "not_needed",
    },
  };
}

async function readFlowFile(
  file: string,
  rejectSymlinks: boolean,
): Promise<string> {
  const handle = await open(
    file,
    constants.O_RDONLY | (rejectSymlinks ? (constants.O_NOFOLLOW ?? 0) : 0),
  );
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function loadFlowFile(
  file: string,
  options: ParseFlowOptions,
): Promise<ParsedFlowResult> {
  try {
    const source = await readFlowFile(file, options.rejectSymlinks ?? false);
    return parseFlow(source, file, options);
  } catch {
    return unreadableResult(file);
  }
}
