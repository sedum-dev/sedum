import { parseDataTemplate, tokenizeStep } from "./flow-values.js";
import type {
  FlowDiagnostic,
  FlowScalar,
  FlowSource,
  FlowStep,
} from "./flow-types.js";
import {
  addDiagnostic,
  sourceAt,
  type LoaderContext,
} from "./flow-loader-context.js";

type FlowPhase = "before" | "steps" | "after";

function checkPlaceholders(
  text: string,
  source: FlowSource,
  knownData: ReadonlySet<string>,
  diagnostics: FlowDiagnostic[],
  outputPlaceholderStart?: number,
): ReturnType<typeof tokenizeStep> {
  const lexical = tokenizeStep(text);
  for (const problem of lexical.problems)
    addDiagnostic(
      diagnostics,
      "error",
      problem.code,
      source,
      problem.message,
      problem.fix,
    );
  for (const token of lexical.tokens) {
    if (token.kind !== "placeholder") continue;
    if (token.start === outputPlaceholderStart || knownData.has(token.key!))
      continue;
    addDiagnostic(
      diagnostics,
      "error",
      "unknown_placeholder",
      source,
      `${token.text} is not in this test's data.`,
      `Declare \`${token.key}\` under data or correct the placeholder name.`,
    );
  }
  return lexical;
}

export function checkTextPlaceholders(
  text: string,
  source: FlowSource,
  knownData: ReadonlySet<string>,
  diagnostics: FlowDiagnostic[],
): void {
  checkPlaceholders(text, source, knownData, diagnostics);
}

function rememberBinding(text: string): RegExpExecArray | null {
  return /^(?:remember|capture)\b[\s\S]*\bas\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*\.?$/iu.exec(
    text.trim(),
  );
}

function registerBinding(
  binding: RegExpExecArray,
  source: FlowSource,
  knownData: Set<string>,
  diagnostics: FlowDiagnostic[],
): void {
  const key = binding[1]!;
  if (knownData.has(key))
    addDiagnostic(
      diagnostics,
      "error",
      "duplicate_remember_binding",
      source,
      `{{${key}}} is already declared by data or an earlier remember step.`,
      "Choose a new binding name; remembered values cannot replace existing data.",
    );
  else knownData.add(key);
}

function parseSentence(
  text: string,
  phase: FlowPhase,
  source: FlowSource,
  knownData: Set<string>,
  diagnostics: FlowDiagnostic[],
): FlowStep {
  const binding = rememberBinding(text);
  const lexical = checkPlaceholders(
    text,
    source,
    knownData,
    diagnostics,
    binding ? text.lastIndexOf("{{") : undefined,
  );
  if (binding) registerBinding(binding, source, knownData, diagnostics);
  return { kind: "sentence", phase, text, tokens: lexical.tokens, source };
}

function moduleArgumentSources(
  values: Record<string, FlowScalar>,
  phase: FlowPhase,
  index: number,
  context: LoaderContext,
  knownData: Set<string>,
): Record<string, FlowSource> {
  const sources: Record<string, FlowSource> = Object.create(null) as Record<
    string,
    FlowSource
  >;
  for (const [key, value] of Object.entries(values)) {
    const source = sourceAt(context, [phase, index, "with", key]);
    sources[key] = source;
    if (typeof value !== "string") continue;
    checkPlaceholders(value, source, knownData, context.diagnostics);
    const template = parseDataTemplate(value);
    if ("error" in template)
      addDiagnostic(
        context.diagnostics,
        "error",
        "invalid_env_template",
        source,
        `Invalid environment template for module argument ${key}.`,
        template.error,
      );
  }
  return sources;
}

function parseModuleStep(
  mapping: Record<string, unknown>,
  phase: FlowPhase,
  index: number,
  source: FlowSource,
  context: LoaderContext,
  knownData: Set<string>,
): FlowStep | null {
  if (typeof mapping.use !== "string" || !mapping.use) return null;
  if (!mapping.use.endsWith(".module.yaml"))
    addDiagnostic(
      context.diagnostics,
      "error",
      "invalid_module_path",
      source,
      "A use step must reference a .module.yaml file.",
      "Write `use: path/to/login.module.yaml`.",
    );
  const withValues = (mapping.with ?? {}) as Record<string, FlowScalar>;
  return {
    kind: "module",
    phase,
    use: mapping.use,
    with: withValues,
    withSources: moduleArgumentSources(
      withValues,
      phase,
      index,
      context,
      knownData,
    ),
    source,
    sourceStack: [source],
  };
}

function reportRun(source: FlowSource, diagnostics: FlowDiagnostic[]): void {
  addDiagnostic(
    diagnostics,
    "error",
    "unsupported_run",
    source,
    "The run step is not supported by the v1 loader.",
    "Use a sentence step; SED-11 will define user-code steps.",
  );
}

function parseStep(
  item: unknown,
  phase: FlowPhase,
  index: number,
  context: LoaderContext,
  knownData: Set<string>,
): FlowStep | null {
  const source = sourceAt(context, [phase, index]);
  if (typeof item === "string")
    return item.trim()
      ? parseSentence(item, phase, source, knownData, context.diagnostics)
      : null;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const mapping = item as Record<string, unknown>;
  if ("run" in mapping) {
    reportRun(source, context.diagnostics);
    return null;
  }
  return parseModuleStep(mapping, phase, index, source, context, knownData);
}

export function parseSteps(
  phase: FlowPhase,
  raw: unknown,
  context: LoaderContext,
  knownData: Set<string>,
): FlowStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    const step = parseStep(item, phase, index, context, knownData);
    return step ? [step] : [];
  });
}
