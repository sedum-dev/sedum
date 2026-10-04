import path from "node:path";
import { z } from "zod";
import { isFlowScalar, parseDataTemplate } from "./flow-values.js";
import type {
  DeclaredDataValue,
  FlowDefinition,
  FlowDiagnostic,
  FlowStep,
  ParsedFlowResult,
} from "./flow-types.js";
import type { ParseFlowOptions } from "./flow-loader.js";
import {
  addDiagnostic,
  compareDiagnostics,
  createLoaderContext,
  decodeNode,
  sourceAt,
  type LoaderContext,
} from "./flow-loader-context.js";
import { checkTextPlaceholders, parseSteps } from "./flow-loader-steps.js";
import { parseMappingDocument } from "./flow-loader-yaml.js";

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

function removeUnknownKeys(
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  for (const key of Object.keys(plain)) {
    if (knownKeys.includes(key)) continue;
    addDiagnostic(
      context.diagnostics,
      "error",
      "unknown_key",
      sourceAt(context, [key, "$key"]),
      `Unknown top-level key \`${key}\`.`,
      keyFix(key),
    );
    delete plain[key];
  }
}

function normalizeVersion(
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  if (plain.sedum === undefined || plain.sedum === 1) return;
  addDiagnostic(
    context.diagnostics,
    "error",
    "unsupported_version",
    sourceAt(context, ["sedum"]),
    `Unsupported Sedum format version ${String(plain.sedum)}.`,
    "Use `sedum: 1` or omit the marker for v1.",
  );
  delete plain.sedum;
}

function checkTestMode(
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  if ((plain.goal === undefined) !== (plain.steps === undefined)) return;
  addDiagnostic(
    context.diagnostics,
    "error",
    "invalid_test_mode",
    sourceAt(context, []),
    plain.goal === undefined
      ? "This test has neither a `steps` list nor a `goal`."
      : "This test has both a `steps` list and a `goal`; use one.",
    "Use `steps` for authored actions, or `goal` with a required `verify` claim.",
  );
}

function checkGoalVerification(
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  if ((plain.goal === undefined) === (plain.verify === undefined)) return;
  addDiagnostic(
    context.diagnostics,
    "error",
    "invalid_goal_verification",
    sourceAt(context, [plain.goal === undefined ? "verify" : "goal"]),
    "Top-level `goal` and `verify` must be supplied together.",
    "Add a nonempty independent `verify` claim to a goal test; use verify sentences in authored steps.",
  );
}

function issueIsUnsupportedRun(
  plain: Record<string, unknown>,
  path: PropertyKey[],
): boolean {
  const key = String(path[0] ?? "root");
  const suspect = Array.isArray(plain[key])
    ? plain[key][Number(path[1])]
    : undefined;
  return Boolean(
    suspect &&
    typeof suspect === "object" &&
    !Array.isArray(suspect) &&
    "run" in suspect,
  );
}

function reportSchemaIssues(
  result: ReturnType<typeof v1Schema.safeParse>,
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    if (issueIsUnsupportedRun(plain, issue.path)) continue;
    const parts = issue.path.map(String);
    const key = String(parts[0] ?? "root");
    const missingSteps =
      key === "steps" &&
      issue.code === "invalid_type" &&
      plain.steps === undefined;
    addDiagnostic(
      context.diagnostics,
      "error",
      issue.code === "unrecognized_keys" ? "unknown_key" : "invalid_field",
      sourceAt(context, parts),
      missingSteps
        ? "This test needs a `steps` list."
        : `Invalid \`${parts.join(".") || "test"}\`: ${issue.message}.`,
      missingSteps
        ? "Add `steps:` with at least one sentence."
        : `Correct the value or shape of \`${key}\` for the v1 format.`,
    );
  }
}

function reportDataTemplate(
  key: string,
  value: string,
  data: Record<string, DeclaredDataValue>,
  context: LoaderContext,
): void {
  const template = parseDataTemplate(value);
  if (!("error" in template)) return;
  addDiagnostic(
    context.diagnostics,
    "error",
    "invalid_env_template",
    data[key]!.source,
    `Invalid environment template for data.${key}.`,
    template.error,
  );
}

function reportScalarCoercion(
  source: string,
  key: string,
  value: number,
  data: Record<string, DeclaredDataValue>,
  context: LoaderContext,
): void {
  const node = context.nodes.get(JSON.stringify(["data", key]));
  if (!node?.range) return;
  const written = source.slice(node.range[0], node.range[1]);
  if (written === String(value)) return;
  addDiagnostic(
    context.diagnostics,
    "warning",
    "scalar_coercion",
    data[key]!.source,
    `YAML reads ${written} as ${String(value)} before typing.`,
    "Quote this data value if its written characters must be preserved.",
  );
}

function parseData(
  source: string,
  raw: unknown,
  context: LoaderContext,
): Record<string, DeclaredDataValue> {
  const data: Record<string, DeclaredDataValue> = Object.create(null) as Record<
    string,
    DeclaredDataValue
  >;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return data;
  for (const [key, value] of Object.entries(raw)) {
    if (!isFlowScalar(value)) continue;
    data[key] = { value, source: sourceAt(context, ["data", key]) };
    if (typeof value === "string")
      reportDataTemplate(key, value, data, context);
    else if (typeof value === "number")
      reportScalarCoercion(source, key, value, data, context);
  }
  return data;
}

function checkGoalPlaceholders(
  plain: Record<string, unknown>,
  knownData: ReadonlySet<string>,
  context: LoaderContext,
): void {
  for (const key of ["goal", "verify"] as const) {
    const text = plain[key];
    if (typeof text === "string")
      checkTextPlaceholders(
        text,
        sourceAt(context, [key]),
        knownData,
        context.diagnostics,
      );
  }
}

function reportInvalidUrl(
  context: LoaderContext,
  source: ReturnType<typeof sourceAt>,
  fix: string,
): void {
  addDiagnostic(
    context.diagnostics,
    "error",
    "invalid_url",
    source,
    "Invalid test URL.",
    fix,
  );
}

function isInvalidUrlScheme(url: string): boolean {
  return (
    /\s/.test(url) ||
    (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url))
  );
}

function warnDiscardedBasePath(
  source: ReturnType<typeof sourceAt>,
  baseUrl: string,
  context: LoaderContext,
): void {
  try {
    if (new URL(baseUrl).pathname === "/") return;
    addDiagnostic(
      context.diagnostics,
      "warning",
      "base_path_discarded",
      source,
      "This leading-slash URL drops the configured base path.",
      "Use a path without a leading slash if it should stay under the base path.",
    );
  } catch {
    // Base config is validated by its owner, not by the flow loader.
  }
}

function checkUrl(
  url: string,
  baseUrl: string | undefined,
  context: LoaderContext,
): void {
  const source = sourceAt(context, ["url"]);
  if (isInvalidUrlScheme(url)) {
    reportInvalidUrl(
      context,
      source,
      "Use an HTTP(S) URL or a relative path without spaces.",
    );
    return;
  }
  try {
    new URL(url, "https://sedum.invalid/");
  } catch {
    reportInvalidUrl(
      context,
      source,
      "Use an HTTP(S) URL or a valid relative path.",
    );
    return;
  }
  if (baseUrl && url.startsWith("/") && !url.startsWith("//"))
    warnDiscardedBasePath(source, baseUrl, context);
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

function relativeIdentity(
  file: string,
  repoRoot: string,
  context: LoaderContext,
): string | null {
  const absolute = path.resolve(repoRoot, file);
  const relative = path
    .relative(path.resolve(repoRoot), absolute)
    .replaceAll("\\", "/");
  if (relative !== ".." && !relative.startsWith("../")) return relative;
  addDiagnostic(
    context.diagnostics,
    "error",
    "file_outside_repo",
    { file, line: 1, col: 1 },
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

function buildDefinition(
  input: ParsedInput,
  file: string,
  relative: string,
  parts: ParsedParts,
  context: LoaderContext,
): FlowDefinition {
  return {
    version: 1,
    file,
    identity: input.id ?? relative,
    ...(input.id === undefined
      ? {}
      : { explicitId: input.id, idSource: sourceAt(context, ["id"]) }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.url === undefined
      ? {}
      : { url: input.url, urlSource: sourceAt(context, ["url"]) }),
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
            source: sourceAt(context, ["goal"]),
            verify: input.verify,
            verifySource: sourceAt(context, ["verify"]),
          },
        }),
  };
}

function finishResult(
  value: FlowDefinition,
  format: "passed" | "failed",
  modules: boolean,
  context: LoaderContext,
): ParsedFlowResult {
  const diagnostics = sortedDiagnostics(context);
  if (format === "passed")
    return { value, diagnostics, coverage: coverage(format, modules) };
  const errors = diagnostics.filter((item) => item.severity === "error");
  const candidate = errors.every((item) => recoverableErrors.has(item.code));
  return {
    ...(candidate ? { candidate: value } : {}),
    diagnostics,
    coverage: coverage(format, modules),
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
  removeUnknownKeys(plain, context);
  normalizeVersion(plain, context);
  checkTestMode(plain, context);
  checkGoalVerification(plain, context);
  const parsed = v1Schema.safeParse(plain);
  reportSchemaIssues(parsed, plain, context);
  const data = parseData(source, plain.data, context);
  const knownData = new Set(Object.keys(data));
  const before = parseSteps("before", plain.before, context, knownData);
  const steps = parseSteps("steps", plain.steps, context, knownData);
  checkGoalPlaceholders(plain, knownData, context);
  const after = parseSteps("after", plain.after, context, knownData);
  if (typeof plain.url === "string")
    checkUrl(plain.url, options.baseUrl, context);
  const modules = hasModule(before, steps, after);
  const format = context.diagnostics.some((item) => item.severity === "error")
    ? "failed"
    : "passed";
  if (!parsed.success)
    return {
      diagnostics: sortedDiagnostics(context),
      coverage: coverage(format, modules),
    };
  const relative = relativeIdentity(file, options.repoRoot, context);
  if (relative === null)
    return {
      diagnostics: sortedDiagnostics(context),
      coverage: coverage("failed", modules),
    };
  const value = buildDefinition(
    parsed.data,
    file,
    relative,
    { data, before, steps, after },
    context,
  );
  return finishResult(value, format, modules, context);
}
