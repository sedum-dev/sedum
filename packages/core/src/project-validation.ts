import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  classifyParsedFlow,
  classifySentenceSteps,
  type ClassifyFlowOptions,
} from "./flow-classification.js";
import { WAIT_UNTIL } from "./classification.js";
import {
  findIdentityCollisions,
  loadFlowFile,
  parseModule,
} from "./flow-loader.js";
import { resolveFlowModules } from "./flow-modules.js";
import { resolveEntryUrl } from "./flow-runner.js";
import {
  isFullyValidated,
  type FlowDefinition,
  type FlowDiagnostic,
  type FlowStep,
  type FullValidationCoverage,
  type SentenceStep,
} from "./flow-types.js";
import type { ProviderCall } from "./provider.js";
import { tokenizeStep } from "./flow-values.js";
import {
  isScriptTestFile,
  loadScriptFile,
  scriptListingEntries,
} from "./script-loader.js";
import {
  scanImportBindings,
  scanLocalImports,
  scanScriptSentences,
  type ScriptSentenceScan,
} from "./script-sentences.js";

export interface ProjectValidationOptions extends ClassifyFlowOptions {
  /** The real project root returned by `discoverProjectFiles`. */
  readonly repoRoot: string;
  /**
   * The configured base URL. When present (including `null` for "none"),
   * each test's entry URL is resolved exactly as `sedum run` resolves it.
   */
  readonly baseUrl?: string | null;
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

/** The pre-launch entry-URL failure `sedum run` would report, if any. */
function entryUrlDiagnostic(
  flow: FlowDefinition,
  baseUrl: string | null,
): FlowDiagnostic | null {
  try {
    resolveEntryUrl(flow.url, baseUrl ?? undefined);
    return null;
  } catch (error) {
    return {
      severity: "error",
      code: "invalid_entry_url",
      source: flow.urlSource ?? { file: flow.file, line: 1, col: 1 },
      message:
        error instanceof Error ? error.message : "The test URL is invalid.",
      fix: "Give the test an absolute `url`, or set `baseUrl` in sedum.config.yaml.",
    };
  }
}

/**
 * Import a `*.test.ts` file for its `test()` declarations and classify the
 * literal sentences its `ai` calls name. Sentences built at run time are
 * warnings: they can only be classified when they run.
 */
async function validateScriptFile(
  file: string,
  options: ProjectValidationOptions,
  classify: ClassifyFlowOptions,
): Promise<{
  readonly headers: readonly FlowDefinition[];
  readonly diagnostics: readonly FlowDiagnostic[];
  readonly calls: readonly ProviderCall[];
  readonly coverage: FullValidationCoverage;
}> {
  const script = await loadScriptFile(file, { repoRoot: options.repoRoot });
  const headers = scriptListingEntries(script).flatMap((entry) =>
    entry.result.value ? [entry.result.value] : [],
  );
  const diagnostics: FlowDiagnostic[] = [...script.diagnostics];
  for (const header of headers) {
    // A script test without a url starts on a blank page.
    if (header.url === undefined || options.baseUrl === undefined) continue;
    const entry = entryUrlDiagnostic(header, options.baseUrl);
    if (entry)
      diagnostics.push({
        ...entry,
        source:
          script.tests.find((test) => test.identity === header.identity)
            ?.source ?? entry.source,
      });
  }
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return {
      headers,
      diagnostics: [
        ...diagnostics,
        {
          severity: "error",
          code: "unreadable_file",
          source: { file, line: 1, col: 1 },
          message: "The test file could not be read.",
          fix: "Check the file permissions and rerun.",
        },
      ],
      calls: [],
      coverage: {
        format: "failed",
        steps: "not_checked",
        modules: "not_needed",
      },
    };
  }
  // Sentences in local helper modules the test imports are steps too.
  const read = [{ file, source, scan: scanScriptSentences(source, file) }];
  const { helpers, truncated } = await localHelpers(
    file,
    source,
    options.repoRoot,
  );
  for (const helper of helpers) {
    const text = await readFile(helper, "utf8").catch(() => "");
    read.push({
      file: helper,
      source: text,
      scan: scanScriptSentences(text, helper),
    });
  }
  const scans = read.map((item) => item.scan);
  const warnings = [
    ...scans.flatMap((scan) => scan.warnings),
    ...unresolvedHelperCalls(read),
  ];
  if (truncated)
    warnings.push({
      severity: "warning",
      code: "too_many_helpers",
      source: { file, line: 1, col: 1 },
      message: `This test imports more than ${MAX_HELPERS} local modules; the sentences in the rest were not checked.`,
      fix: "Keep shared steps in fewer modules.",
    });
  diagnostics.push(...warnings);
  const scanned = scans.flatMap((scan) => scan.sentences);
  const sentences: SentenceStep[] = scanned.map((item) => ({
    kind: "sentence",
    phase: "steps",
    text: item.text,
    tokens: tokenizeStep(item.text).tokens,
    source: item.source,
  }));
  const checked = await classifySentenceSteps(sentences, classify);
  diagnostics.push(...checked.diagnostics);
  const invalidChecks: FlowDiagnostic[] = [];
  scanned.forEach((item, index) => {
    const classified = checked.classification.steps[index];
    if (
      !item.check ||
      !classified ||
      (classified.op === "verify" && !WAIT_UNTIL.test(item.text))
    )
      return;
    invalidChecks.push({
      severity: "error",
      code: "invalid_check",
      source: item.source,
      message: "ai.holds takes one claim about the page.",
      fix: 'Write ai.holds("the passkey screen is shown").',
    });
  });
  diagnostics.push(...invalidChecks);
  // A sentence that is not a literal was not checked: never report it valid.
  const complete =
    checked.classification.steps.every((step) => step !== null) &&
    checked.diagnostics.length === 0 &&
    invalidChecks.length === 0 &&
    warnings.length === 0;
  return {
    headers,
    diagnostics,
    calls: checked.classification.calls,
    coverage: {
      format: script.diagnostics.length ? "failed" : "passed",
      steps: complete ? "checked" : "incomplete",
      modules: "not_needed",
    },
  };
}

const HELPER_EXTENSIONS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs"];
const MAX_HELPERS = 64;

/** Resolve `./support/login.js` the way a TypeScript import would. */
function resolveHelper(from: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(from), specifier);
  const stem = base.replace(/\.(?:m|c)?js$/u, "");
  const candidates = [
    base,
    ...HELPER_EXTENSIONS.map((extension) => stem + extension),
    ...HELPER_EXTENSIONS.map((extension) =>
      path.join(base, `index${extension}`),
    ),
  ];
  return candidates.find(
    (candidate) =>
      HELPER_EXTENSIONS.some((extension) => candidate.endsWith(extension)) &&
      existsSync(candidate) &&
      statSync(candidate).isFile(),
  );
}

/**
 * The local modules a test file imports, directly or through other helpers,
 * inside the project and outside `node_modules`.
 */
/**
 * `login(ai)` hands the test's ai to an imported helper. Its sentences are
 * checked only if that helper's parameter at that position is named `ai`;
 * any other name, or a helper validation cannot find, is a warning.
 */
function unresolvedHelperCalls(
  read: readonly {
    readonly file: string;
    readonly source: string;
    readonly scan: ScriptSentenceScan;
  }[],
): FlowDiagnostic[] {
  const byPath = new Map(
    read.map((item) => [realpathSync.native(item.file), item.scan]),
  );
  const warnings: FlowDiagnostic[] = [];
  for (const { file, source, scan } of read) {
    if (!scan.helperCalls.length) continue;
    const imports = scanImportBindings(source);
    for (const call of scan.helperCalls) {
      const binding = imports.find((item) => item.local === call.callee);
      const target = binding
        ? resolveHelper(file, binding.specifier)
        : undefined;
      const helper = target
        ? byPath.get(realpathSync.native(target))
        : undefined;
      const parameters =
        binding && helper ? helper.functions.get(binding.imported) : undefined;
      // The test's context or `{ ai }` is fine in any helper validation
      // reads; the test's ai itself must arrive under the name `ai`.
      if (
        call.passes === "context"
          ? parameters
          : parameters?.[call.position] === "ai"
      )
        continue;
      warnings.push({
        severity: "warning",
        code: "unchecked_call",
        source: call.source,
        message: parameters
          ? `\`${call.callee}\` receives the test's ai under another name, so the steps it runs are not checked before a run.`
          : `Validation cannot follow \`${call.callee}\` to a local module, so the steps it runs with the test's ai are not checked before a run.`,
        fix: "Declare the helper in the test file or a local module, with its parameter named `ai`.",
      });
    }
  }
  return warnings;
}

async function localHelpers(
  file: string,
  source: string,
  repoRoot: string,
): Promise<{
  readonly helpers: readonly string[];
  readonly truncated: boolean;
}> {
  const root = realpathSync.native(repoRoot);
  const seen = new Set<string>([realpathSync.native(file)]);
  const helpers: string[] = [];
  const queue: [string, string][] = [[file, source]];
  while (queue.length) {
    const [from, text] = queue.shift()!;
    for (const specifier of scanLocalImports(text)) {
      const found = resolveHelper(from, specifier);
      // Contain by real path: a symlink out of the project is not followed.
      const target = found && realpathSync.native(found);
      const relative = target && path.relative(root, target);
      if (
        !target ||
        seen.has(target) ||
        !relative ||
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        relative.split(path.sep).includes("node_modules")
      )
        continue;
      if (helpers.length >= MAX_HELPERS) return { helpers, truncated: true };
      seen.add(target);
      helpers.push(target);
      queue.push([target, await readFile(target, "utf8").catch(() => "")]);
    }
  }
  return { helpers, truncated: false };
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
    if (isScriptTestFile(file)) {
      const checked = await validateScriptFile(file, options, classify);
      flows.push(...checked.headers);
      diagnostics.push(...checked.diagnostics);
      calls.push(...checked.calls);
      if (!isFullyValidated(checked.coverage, checked.diagnostics))
        allTestsValidated = false;
      files.push({
        file,
        kind: "test",
        ...(checked.headers[0]
          ? { identity: checked.headers[0].identity }
          : {}),
        coverage: checked.coverage,
      });
      continue;
    }
    const loaded = await loadFlowFile(file, {
      repoRoot: options.repoRoot,
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });
    const flow = loaded.value ?? loaded.candidate;
    if (flow) flows.push(flow);
    const entry =
      flow && options.baseUrl !== undefined
        ? entryUrlDiagnostic(flow, options.baseUrl)
        : null;
    if (entry) {
      diagnostics.push(entry);
      allTestsValidated = false;
    }
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
