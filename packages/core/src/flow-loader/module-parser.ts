import { z } from "zod";
import type { ModuleDefinition, ParsedModuleResult } from "../flow-types.js";
import {
  addDiagnostic,
  compareDiagnostics,
  createLoaderContext,
  decodeNode,
  sourceAt,
  type LoaderContext,
} from "./context.js";
import { parseSteps } from "./steps.js";
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
const moduleSchema = z.strictObject({
  parameters: z.array(dataKeySchema),
  steps: z.array(stepSchema).min(1),
});

function sortedResult(
  context: LoaderContext,
  value?: ModuleDefinition,
): ParsedModuleResult {
  return {
    ...(value ? { value } : {}),
    diagnostics: context.diagnostics.sort(compareDiagnostics),
  };
}

function checkFileSuffix(file: string, context: LoaderContext): void {
  if (file.endsWith(".module.yaml")) return;
  addDiagnostic(
    context.diagnostics,
    "error",
    "invalid_module_path",
    { file, line: 1, col: 1 },
    "A module file must end in .module.yaml.",
    "Rename the file with the .module.yaml suffix.",
  );
}

function removeUnknownKeys(
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  for (const key of Object.keys(plain)) {
    if (key === "parameters" || key === "steps") continue;
    addDiagnostic(
      context.diagnostics,
      "error",
      "unknown_module_key",
      sourceAt(context, [key, "$key"]),
      `Unknown module key \`${key}\`.`,
      "Modules contain only `parameters` and `steps`.",
    );
    delete plain[key];
  }
}

function reportSchemaIssues(
  result: ReturnType<typeof moduleSchema.safeParse>,
  plain: Record<string, unknown>,
  context: LoaderContext,
): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    const parts = issue.path.map(String);
    addDiagnostic(
      context.diagnostics,
      "error",
      issue.code === "unrecognized_keys"
        ? "unknown_module_key"
        : "invalid_module_field",
      sourceAt(context, parts),
      `Invalid \`${parts.join(".") || "module"}\`: ${issue.message}.`,
      parts[0] === "steps" && plain.steps === undefined
        ? "Add `steps:` with at least one sentence."
        : "Correct the module field for the v1 format.",
    );
  }
}

function stringParameters(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

function checkDuplicateParameters(
  parameters: readonly string[],
  context: LoaderContext,
): void {
  const seen = new Set<string>();
  for (const [index, parameter] of parameters.entries()) {
    if (seen.has(parameter))
      addDiagnostic(
        context.diagnostics,
        "error",
        "duplicate_module_parameter",
        sourceAt(context, ["parameters", index]),
        `Module parameter \`${parameter}\` is declared more than once.`,
        "Keep each parameter name once.",
      );
    seen.add(parameter);
  }
}

export function parseModuleSource(
  source: string,
  file: string,
): ParsedModuleResult {
  const context = createLoaderContext(file);
  checkFileSuffix(file, context);
  const root = parseMappingDocument(source, context, "module");
  if (!root) return sortedResult(context);
  const plain = decodeNode(root, [], context) as Record<string, unknown>;
  removeUnknownKeys(plain, context);
  const parsed = moduleSchema.safeParse(plain);
  reportSchemaIssues(parsed, plain, context);
  const parameters = stringParameters(plain.parameters);
  checkDuplicateParameters(parameters, context);
  const steps = parseSteps({
    phase: "steps",
    raw: plain.steps,
    loader: context,
    knownData: new Set(parameters),
  });
  if (
    !parsed.success ||
    context.diagnostics.some((item) => item.severity === "error")
  )
    return sortedResult(context);
  return sortedResult(context, {
    file,
    source: sourceAt(context, []),
    parameters: parsed.data.parameters,
    steps,
  });
}
