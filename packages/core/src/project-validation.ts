import { readFile } from "node:fs/promises";
import {
  classifyParsedFlow,
  classifySentenceSteps,
  type ClassifyFlowOptions,
} from "./flow-classification.js";
import {
  findIdentityCollisions,
  loadFlowFile,
  parseModule,
} from "./flow-loader.js";
import { resolveFlowModules } from "./flow-modules.js";
import {
  isFullyValidated,
  type FlowDefinition,
  type FlowDiagnostic,
  type FlowStep,
  type FullValidationCoverage,
  type SentenceStep,
} from "./flow-types.js";
import type { ProviderCall } from "./provider.js";

export interface ProjectValidationOptions extends ClassifyFlowOptions {
  /** The real project root returned by `discoverProjectFiles`. */
  readonly repoRoot: string;
}

export interface ProjectFileValidation {
  readonly file: string;
  readonly kind: "test" | "module";
  /** Tests only. */
  readonly identity?: string;
  /** Tests only; unreferenced modules have no module or coverage context. */
  readonly coverage?: FullValidationCoverage;
  /** Modules only: whether any discovered test's module graph read it. */
  readonly reached?: boolean;
}

export interface ProjectValidationCounts {
  readonly tests: number;
  readonly modules: number;
  readonly unreferencedModules: number;
  /** Error diagnostics other than sentences not classifiable offline. */
  readonly errors: number;
  readonly warnings: number;
  readonly notCheckedOffline: number;
  /** Provider, cache, or file-read failures: the check itself could not run. */
  readonly operational: number;
}

export interface ProjectValidationResult {
  readonly files: readonly ProjectFileValidation[];
  /** Deduplicated and sorted by file, line, column, then code. */
  readonly diagnostics: readonly FlowDiagnostic[];
  readonly counts: ProjectValidationCounts;
  readonly calls: readonly ProviderCall[];
  /** True only when every check ran completely and found no error. */
  readonly fullyValidated: boolean;
}

/** Classification code for a sentence the offline path could not classify. */
export const NOT_CHECKED_OFFLINE_CODE = "unavailable";
const OPERATIONAL_CODES = new Set([
  "provider_error",
  "cache_error",
  "unreadable_file",
]);

/** Deterministic diagnostic order: file, line, column, code, message. */
export function compareDiagnostics(
  a: FlowDiagnostic,
  b: FlowDiagnostic,
): number {
  const text = (left: string, right: string) =>
    left < right ? -1 : left > right ? 1 : 0;
  return (
    text(a.source.file, b.source.file) ||
    a.source.line - b.source.line ||
    a.source.col - b.source.col ||
    text(a.code, b.code) ||
    text(a.message, b.message)
  );
}

/** A module reached from several tests reports each problem once. */
export function dedupeDiagnostics(
  diagnostics: readonly FlowDiagnostic[],
): readonly FlowDiagnostic[] {
  const seen = new Set<string>();
  const unique: FlowDiagnostic[] = [];
  for (const item of diagnostics) {
    const key = JSON.stringify([
      item.severity,
      item.code,
      item.source.file,
      item.source.line,
      item.source.col,
      item.message,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique.sort(compareDiagnostics);
}

function directSentences(steps: readonly FlowStep[]): SentenceStep[] {
  return steps.filter((step): step is SentenceStep => step.kind === "sentence");
}

async function checkUnreferencedModule(
  file: string,
  options: ClassifyFlowOptions,
): Promise<{
  readonly diagnostics: readonly FlowDiagnostic[];
  readonly calls: readonly ProviderCall[];
}> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return {
      diagnostics: [
        {
          severity: "error",
          code: "unreadable_file",
          source: { file, line: 1, col: 1 },
          message: "Could not read this module file.",
          fix: "Check the path and file permissions.",
        },
      ],
      calls: [],
    };
  }
  const parsed = parseModule(source, file);
  if (!parsed.value) return { diagnostics: parsed.diagnostics, calls: [] };
  const checked = await classifySentenceSteps(
    directSentences(parsed.value.steps),
    options,
  );
  return {
    diagnostics: [...parsed.diagnostics, ...checked.diagnostics],
    calls: checked.classification.calls,
  };
}

/**
 * Validate discovered tests and modules without a browser: format, module
 * graphs, and sentence classification in the caller's mode. Each file is
 * checked even when another fails. Modules no test reaches are checked for
 * format and their own sentences; their nested calls are checked from tests.
 */
export async function validateProject(
  input: {
    readonly tests: readonly string[];
    readonly modules: readonly string[];
  },
  options: ProjectValidationOptions,
): Promise<ProjectValidationResult> {
  const classify: ClassifyFlowOptions = {
    mode: options.mode,
    cache: options.cache,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const files: ProjectFileValidation[] = [];
  const diagnostics: FlowDiagnostic[] = [];
  const calls: ProviderCall[] = [];
  const reached = new Set<string>();
  const flows: FlowDefinition[] = [];
  let allTestsValidated = true;

  for (const file of input.tests) {
    const loaded = await loadFlowFile(file, { repoRoot: options.repoRoot });
    const flow = loaded.value ?? loaded.candidate;
    if (flow) flows.push(flow);
    const resolved = await resolveFlowModules(loaded, {
      repoRoot: options.repoRoot,
      partial: true,
    });
    resolved.moduleFiles.forEach((module) => reached.add(module));
    const classified = await classifyParsedFlow(resolved, classify);
    calls.push(...classified.calls);
    diagnostics.push(...classified.diagnostics);
    if (!isFullyValidated(classified.coverage, classified.diagnostics))
      allTestsValidated = false;
    files.push({
      file,
      kind: "test",
      ...(flow ? { identity: flow.identity } : {}),
      coverage: classified.coverage,
    });
  }
  diagnostics.push(...findIdentityCollisions(flows));

  let unreferenced = 0;
  for (const file of input.modules) {
    const isReached = reached.has(file);
    files.push({ file, kind: "module", reached: isReached });
    if (isReached) continue;
    unreferenced++;
    const checked = await checkUnreferencedModule(file, classify);
    diagnostics.push(...checked.diagnostics);
    calls.push(...checked.calls);
  }

  const unique = dedupeDiagnostics(diagnostics);
  let errors = 0,
    warnings = 0,
    notCheckedOffline = 0,
    operational = 0;
  for (const item of unique) {
    if (item.severity === "warning") warnings++;
    else if (item.code === NOT_CHECKED_OFFLINE_CODE) notCheckedOffline++;
    else errors++;
    if (OPERATIONAL_CODES.has(item.code)) operational++;
  }
  return {
    files,
    diagnostics: unique,
    counts: {
      tests: input.tests.length,
      modules: input.modules.length,
      unreferencedModules: unreferenced,
      errors,
      warnings,
      notCheckedOffline,
      operational,
    },
    calls,
    fullyValidated:
      allTestsValidated && errors === 0 && notCheckedOffline === 0,
  };
}
