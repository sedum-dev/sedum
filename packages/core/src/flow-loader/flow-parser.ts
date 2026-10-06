import path from "node:path";
import { z } from "zod";
import { isFlowScalar, parseDataTemplate } from "../flow-values.js";
import type {
  DeclaredDataValue,
  FlowDefinition,
  FlowDiagnostic,
  FlowStep,
  ParsedFlowResult,
} from "../flow-types.js";
import type { ParseFlowOptions } from "../flow-loader.js";
import {
  addDiagnostic,
  compareDiagnostics,
  createLoaderContext,
  decodeNode,
  sourceAt,
  type LoaderContext,
} from "./context.js";
import { checkTextPlaceholders, parseSteps } from "./steps.js";
import { parseMappingDocument } from "./yaml.js";

const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const dataKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const nonemptyText = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");
const useSchema = z.strictObject({
  use: nonemptyText,
  with: z.record(dataKeySchema, scalarSchema).optional(),
});
const stepSchema = z.union([nonemptyText, useSchema]);
const v1Schema = z.strictObject({
  sedum: z.literal(1).optional(),
  id: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  url: z.string().min(1).optional(),
  data: z.record(dataKeySchema, scalarSchema).optional(),
  before: z.array(stepSchema).optional(),
  steps: z.array(stepSchema).min(1).optional(),
  goal: nonemptyText.optional(),
  verify: nonemptyText.optional(),
  after: z.array(stepSchema).optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

type ParsedInput = z.infer<typeof v1Schema>;
type SchemaResult = ReturnType<typeof v1Schema.safeParse>;

interface FlowParseState {
  readonly source: string;
  readonly file: string;
  readonly options: ParseFlowOptions;
  readonly loader: LoaderContext;
  readonly plain: Record<string, unknown>;
}

interface DataParseState {
  readonly flow: FlowParseState;
  readonly data: Record<string, DeclaredDataValue>;
}

interface DataEntry<T extends string | number> {
  readonly key: string;
  readonly value: T;
}

interface UrlCheck {
  readonly flow: FlowParseState;
  readonly url: string;
  readonly baseUrl: string | undefined;
}

const knownKeys = [
  "sedum",
  "id",
  "description",
  "url",
  "data",
  "before",
  "steps",
  "goal",
  "verify",
  "after",
  "tags",
  "meta",
];
const recoverableErrors = new Set([
  "unknown_placeholder",
  "invalid_placeholder",
  "unclosed_quote",
  "duplicate_remember_binding",
]);

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let previous = row[0]!;
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const saved = row[rightIndex]!;
      row[rightIndex] = Math.min(
        row[rightIndex]! + 1,
        row[rightIndex - 1]! + 1,
        previous + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      previous = saved;
    }
  }
  return row[right.length]!;
}

function keyFix(key: string): string {
  if (key === "name")
    return "Use `description` for human-readable text or `id` for identity.";
  if (key === "fileType")
    return "Remove `fileType`; the optional version marker is `sedum: 1`.";
  const suggestion = knownKeys
    .map((known) => ({ known, score: distance(key, known) }))
    .sort((left, right) =>
      left.score === right.score
        ? left.known.localeCompare(right.known)
        : left.score - right.score,
    )[0];
  return suggestion && suggestion.score <= 2
    ? `Did you mean \`${suggestion.known}\`?`
    : `Use one of: ${knownKeys.map((known) => `\`${known}\``).join(", ")}.`;
}

function removeUnknownKeys(state: FlowParseState): void {
  for (const key of Object.keys(state.plain)) {
    if (knownKeys.includes(key)) continue;
    addDiagnostic(
      state.loader.diagnostics,
      "error",
      "unknown_key",
      sourceAt(state.loader, [key, "$key"]),
      `Unknown top-level key \`${key}\`.`,
      keyFix(key),
    );
    delete state.plain[key];
  }
}

function normalizeVersion(state: FlowParseState): void {
  if (state.plain.sedum === undefined || state.plain.sedum === 1) return;
  addDiagnostic(
    state.loader.diagnostics,
    "error",
    "unsupported_version",
    sourceAt(state.loader, ["sedum"]),
    `Unsupported Sedum format version ${String(state.plain.sedum)}.`,
    "Use `sedum: 1` or omit the marker for v1.",
  );
  delete state.plain.sedum;
}

function checkTestMode(state: FlowParseState): void {
  if ((state.plain.goal === undefined) !== (state.plain.steps === undefined))
    return;
  addDiagnostic(
    state.loader.diagnostics,
    "error",
    "invalid_test_mode",
    sourceAt(state.loader, []),
    state.plain.goal === undefined
      ? "This test has neither a `steps` list nor a `goal`."
      : "This test has both a `steps` list and a `goal`; use one.",
    "Use `steps` for authored actions, or `goal` with a required `verify` claim.",
  );
}

function checkGoalVerification(state: FlowParseState): void {
  if ((state.plain.goal === undefined) === (state.plain.verify === undefined))
    return;
  addDiagnostic(
    state.loader.diagnostics,
    "error",
    "invalid_goal_verification",
    sourceAt(state.loader, [
      state.plain.goal === undefined ? "verify" : "goal",
    ]),
    "Top-level `goal` and `verify` must be supplied together.",
    "Add a nonempty independent `verify` claim to a goal test; use verify sentences in authored steps.",
  );
}

function issueIsUnsupportedRun(
  state: FlowParseState,
  path: PropertyKey[],
): boolean {
  const key = String(path[0] ?? "root");
  const suspect = Array.isArray(state.plain[key])
    ? state.plain[key][Number(path[1])]
    : undefined;
  return Boolean(
    suspect &&
    typeof suspect === "object" &&
    !Array.isArray(suspect) &&
    "run" in suspect,
  );
}

function isMissingStepsIssue(
  issue: z.core.$ZodIssue,
  key: string,
  state: FlowParseState,
): boolean {
  if (key !== "steps") return false;
  if (issue.code !== "invalid_type") return false;
  return state.plain.steps === undefined;
}

function reportSchemaIssue(
  issue: z.core.$ZodIssue,
  state: FlowParseState,
): void {
  const parts = issue.path.map(String);
  const key = String(parts[0] ?? "root");
  const missingSteps = isMissingStepsIssue(issue, key, state);
  addDiagnostic(
    state.loader.diagnostics,
    "error",
    issue.code === "unrecognized_keys" ? "unknown_key" : "invalid_field",
    sourceAt(state.loader, parts),
    missingSteps
      ? "This test needs a `steps` list."
      : `Invalid \`${parts.join(".") || "test"}\`: ${issue.message}.`,
    missingSteps
      ? "Add `steps:` with at least one sentence."
      : `Correct the value or shape of \`${key}\` for the v1 format.`,
  );
}

function reportSchemaIssues(result: SchemaResult, state: FlowParseState): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    if (issueIsUnsupportedRun(state, issue.path)) continue;
    reportSchemaIssue(issue, state);
  }
}

function reportDataTemplate(
  entry: DataEntry<string>,
  state: DataParseState,
): void {
  const template = parseDataTemplate(entry.value);
  if (!("error" in template)) return;
  addDiagnostic(
    state.flow.loader.diagnostics,
    "error",
    "invalid_env_template",
    state.data[entry.key]!.source,
    `Invalid environment template for data.${entry.key}.`,
    template.error,
  );
}

function reportScalarCoercion(
  entry: DataEntry<number>,
  state: DataParseState,
): void {
  const node = state.flow.loader.nodes.get(JSON.stringify(["data", entry.key]));
  if (!node?.range) return;
  const written = state.flow.source.slice(node.range[0], node.range[1]);
  if (written === String(entry.value)) return;
  addDiagnostic(
    state.flow.loader.diagnostics,
    "warning",
    "scalar_coercion",
    state.data[entry.key]!.source,
    `YAML reads ${written} as ${String(entry.value)} before typing.`,
    "Quote this data value if its written characters must be preserved.",
  );
}

function isMapping(value: unknown): value is Record<string, unknown> {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}

function parseData(state: FlowParseState): Record<string, DeclaredDataValue> {
  const data: Record<string, DeclaredDataValue> = Object.create(null) as Record<
    string,
    DeclaredDataValue
  >;
  if (!isMapping(state.plain.data)) return data;
  const parsing = { flow: state, data };
  for (const [key, value] of Object.entries(state.plain.data)) {
    if (!isFlowScalar(value)) continue;
    data[key] = { value, source: sourceAt(state.loader, ["data", key]) };
    if (typeof value === "string") reportDataTemplate({ key, value }, parsing);
    else if (typeof value === "number")
      reportScalarCoercion({ key, value }, parsing);
  }
  return data;
}

function checkGoalPlaceholders(
  state: FlowParseState,
  knownData: ReadonlySet<string>,
): void {
  for (const key of ["goal", "verify"] as const) {
    const text = state.plain[key];
    if (typeof text === "string")
      checkTextPlaceholders(text, {
        source: sourceAt(state.loader, [key]),
        knownData,
        diagnostics: state.loader.diagnostics,
      });
  }
}

function reportInvalidUrl(check: UrlCheck, fix: string): void {
  addDiagnostic(
    check.flow.loader.diagnostics,
    "error",
    "invalid_url",
    sourceAt(check.flow.loader, ["url"]),
    "Invalid test URL.",
    fix,
  );
}

function isInvalidUrlScheme(check: UrlCheck): boolean {
  if (/\s/.test(check.url)) return true;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(check.url)) return false;
  return !/^https?:\/\//i.test(check.url);
}

function warnDiscardedBasePath(check: UrlCheck): void {
  if (!check.baseUrl) return;
  try {
    if (new URL(check.baseUrl).pathname === "/") return;
    addDiagnostic(
      check.flow.loader.diagnostics,
      "warning",
      "base_path_discarded",
      sourceAt(check.flow.loader, ["url"]),
      "This leading-slash URL drops the configured base path.",
      "Use a path without a leading slash if it should stay under the base path.",
    );
  } catch {
    // Base config is validated by its owner, not by the flow loader.
  }
}

function hasDiscardedBasePath(check: UrlCheck): boolean {
  if (!check.baseUrl) return false;
  if (!check.url.startsWith("/")) return false;
  return !check.url.startsWith("//");
}

function checkUrl(state: FlowParseState): void {
  const url = state.plain.url;
  if (typeof url !== "string") return;
  const check = { flow: state, url, baseUrl: state.options.baseUrl };
  if (isInvalidUrlScheme(check)) {
    reportInvalidUrl(
      check,
      "Use an HTTP(S) URL or a relative path without spaces.",
    );
    return;
  }
  try {
    new URL(url, "https://sedum.invalid/");
  } catch {
    reportInvalidUrl(check, "Use an HTTP(S) URL or a valid relative path.");
    return;
  }
  if (hasDiscardedBasePath(check)) warnDiscardedBasePath(check);
}

function hasModule(...phases: FlowStep[][]): boolean {
  return phases.flat().some((step) => step.kind === "module");
}

function coverage(
  format: "passed" | "failed",
  modules: boolean,
): ParsedFlowResult["coverage"] {
  return {
    format,
    steps: "not_checked",
    modules: modules ? "not_checked" : "not_needed",
  };
}

function sortedDiagnostics(context: LoaderContext): FlowDiagnostic[] {
  return context.diagnostics.sort(compareDiagnostics);
}

function failedDocument(context: LoaderContext): ParsedFlowResult {
  return {
    diagnostics: sortedDiagnostics(context),
    coverage: coverage("failed", false),
  };
}

function relativeIdentity(state: FlowParseState): string | null {
  const absolute = path.resolve(state.options.repoRoot, state.file);
  const relative = path
    .relative(path.resolve(state.options.repoRoot), absolute)
    .replaceAll("\\", "/");
  if (relative !== ".." && !relative.startsWith("../")) return relative;
  addDiagnostic(
    state.loader.diagnostics,
    "error",
    "file_outside_repo",
    { file: state.file, line: 1, col: 1 },
    "The test file is outside the repository root.",
    "Pass the correct repository root.",
  );
  return null;
}

interface ParsedParts {
  readonly data: Record<string, DeclaredDataValue>;
  readonly before: FlowStep[];
  readonly steps: FlowStep[];
  readonly after: FlowStep[];
}

interface DefinitionInput {
  readonly input: ParsedInput;
  readonly relative: string;
  readonly parts: ParsedParts;
  readonly flow: FlowParseState;
}

function buildDefinition(definition: DefinitionInput): FlowDefinition {
  const { input, relative, parts, flow } = definition;
  return {
    version: 1,
    file: flow.file,
    identity: input.id ?? relative,
    ...(input.id === undefined
      ? {}
      : { explicitId: input.id, idSource: sourceAt(flow.loader, ["id"]) }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.url === undefined
      ? {}
      : { url: input.url, urlSource: sourceAt(flow.loader, ["url"]) }),
    tags: input.tags ?? [],
    meta: input.meta ?? {},
    data: parts.data,
    before: parts.before,
    steps: parts.steps,
    after: parts.after,
    ...(input.goal === undefined || input.verify === undefined
      ? {}
      : {
          goal: {
            text: input.goal,
            source: sourceAt(flow.loader, ["goal"]),
            verify: input.verify,
            verifySource: sourceAt(flow.loader, ["verify"]),
          },
        }),
  };
}

interface FlowResultInput {
  readonly value: FlowDefinition;
  readonly format: "passed" | "failed";
  readonly modules: boolean;
  readonly loader: LoaderContext;
}

function finishResult(input: FlowResultInput): ParsedFlowResult {
  const diagnostics = sortedDiagnostics(input.loader);
  if (input.format === "passed")
    return {
      value: input.value,
      diagnostics,
      coverage: coverage(input.format, input.modules),
    };
  const errors = diagnostics.filter((item) => item.severity === "error");
  const candidate = errors.every((item) => recoverableErrors.has(item.code));
  return {
    ...(candidate ? { candidate: input.value } : {}),
    diagnostics,
    coverage: coverage(input.format, input.modules),
  };
}

export function parseFlowSource(
  source: string,
  file: string,
  options: ParseFlowOptions,
): ParsedFlowResult {
  const context = createLoaderContext(file);
  const root = parseMappingDocument(source, context, "flow");
  if (!root) return failedDocument(context);
  const plain = decodeNode(root, [], context) as Record<string, unknown>;
  const state = { source, file, options, loader: context, plain };
  removeUnknownKeys(state);
  normalizeVersion(state);
  checkTestMode(state);
  checkGoalVerification(state);
  const parsed = v1Schema.safeParse(plain);
  reportSchemaIssues(parsed, state);
  const data = parseData(state);
  const knownData = new Set(Object.keys(data));
  const parsePhase = (phase: "before" | "steps" | "after") =>
    parseSteps({ phase, raw: plain[phase], loader: context, knownData });
  const before = parsePhase("before");
  const steps = parsePhase("steps");
  checkGoalPlaceholders(state, knownData);
  const after = parsePhase("after");
  checkUrl(state);
  const modules = hasModule(before, steps, after);
  const format = context.diagnostics.some((item) => item.severity === "error")
    ? "failed"
    : "passed";
  if (!parsed.success)
    return {
      diagnostics: sortedDiagnostics(context),
      coverage: coverage(format, modules),
    };
  const relative = relativeIdentity(state);
  if (relative === null)
    return {
      diagnostics: sortedDiagnostics(context),
      coverage: coverage("failed", modules),
    };
  const value = buildDefinition({
    input: parsed.data,
    relative,
    parts: { data, before, steps, after },
    flow: state,
  });
  return finishResult({ value, format, modules, loader: context });
}
