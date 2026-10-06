import { parseDataTemplate, tokenizeStep } from "../flow-values.js";
import type {
  FlowDiagnostic,
  FlowScalar,
  FlowSource,
  FlowStep,
} from "../flow-types.js";
import { addDiagnostic, sourceAt, type LoaderContext } from "./context.js";

type FlowPhase = "before" | "steps" | "after";

export interface PlaceholderContext {
  readonly source: FlowSource;
  readonly knownData: ReadonlySet<string>;
  readonly diagnostics: FlowDiagnostic[];
  readonly outputPlaceholderStart?: number;
}

interface StepContext {
  readonly phase: FlowPhase;
  readonly index: number;
  readonly source: FlowSource;
  readonly loader: LoaderContext;
  readonly knownData: Set<string>;
}

interface ModuleArgument {
  readonly key: string;
  readonly value: string;
  readonly source: FlowSource;
}

export interface StepsInput {
  readonly phase: FlowPhase;
  readonly raw: unknown;
  readonly loader: LoaderContext;
  readonly knownData: Set<string>;
}

function checkPlaceholders(
  text: string,
  context: PlaceholderContext,
): ReturnType<typeof tokenizeStep> {
  const lexical = tokenizeStep(text);
  for (const problem of lexical.problems)
    addDiagnostic(
      context.diagnostics,
      "error",
      problem.code,
      context.source,
      problem.message,
      problem.fix,
    );
  for (const token of lexical.tokens) {
    if (token.kind !== "placeholder") continue;
    if (token.start === context.outputPlaceholderStart) continue;
    if (context.knownData.has(token.key!)) continue;
    addDiagnostic(
      context.diagnostics,
      "error",
      "unknown_placeholder",
      context.source,
      `${token.text} is not in this test's data.`,
      `Declare \`${token.key}\` under data or correct the placeholder name.`,
    );
  }
  return lexical;
}

export function checkTextPlaceholders(
  text: string,
  context: PlaceholderContext,
): void {
  checkPlaceholders(text, context);
}

function rememberBinding(text: string): RegExpExecArray | null {
  return /^(?:remember|capture)\b[\s\S]*\bas\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*\.?$/iu.exec(
    text.trim(),
  );
}

function registerBinding(binding: RegExpExecArray, context: StepContext): void {
  const key = binding[1]!;
  if (context.knownData.has(key))
    addDiagnostic(
      context.loader.diagnostics,
      "error",
      "duplicate_remember_binding",
      context.source,
      `{{${key}}} is already declared by data or an earlier remember step.`,
      "Choose a new binding name; remembered values cannot replace existing data.",
    );
  else context.knownData.add(key);
}

function placeholderContext(
  context: StepContext,
  outputPlaceholderStart?: number,
): PlaceholderContext {
  return {
    source: context.source,
    knownData: context.knownData,
    diagnostics: context.loader.diagnostics,
    ...(outputPlaceholderStart === undefined ? {} : { outputPlaceholderStart }),
  };
}

function parseSentence(text: string, context: StepContext): FlowStep {
  const binding = rememberBinding(text);
  const lexical = checkPlaceholders(
    text,
    placeholderContext(context, binding ? text.lastIndexOf("{{") : undefined),
  );
  if (binding) registerBinding(binding, context);
  return {
    kind: "sentence",
    phase: context.phase,
    text,
    tokens: lexical.tokens,
    source: context.source,
  };
}

function argumentSource(context: StepContext, key: string): FlowSource {
  return sourceAt(context.loader, [context.phase, context.index, "with", key]);
}

function checkArgumentTemplate(
  argument: ModuleArgument,
  context: StepContext,
): void {
  checkPlaceholders(argument.value, {
    source: argument.source,
    knownData: context.knownData,
    diagnostics: context.loader.diagnostics,
  });
  const template = parseDataTemplate(argument.value);
  if (!("error" in template)) return;
  addDiagnostic(
    context.loader.diagnostics,
    "error",
    "invalid_env_template",
    argument.source,
    `Invalid environment template for module argument ${argument.key}.`,
    template.error,
  );
}

function moduleArgumentSources(
  values: Record<string, FlowScalar>,
  context: StepContext,
): Record<string, FlowSource> {
  const sources: Record<string, FlowSource> = Object.create(null) as Record<
    string,
    FlowSource
  >;
  for (const [key, value] of Object.entries(values)) {
    const source = argumentSource(context, key);
    sources[key] = source;
    if (typeof value === "string")
      checkArgumentTemplate({ key, value, source }, context);
  }
  return sources;
}

function parseModuleStep(
  mapping: Record<string, unknown>,
  context: StepContext,
): FlowStep | null {
  if (typeof mapping.use !== "string") return null;
  if (mapping.use.length === 0) return null;
  if (!mapping.use.endsWith(".module.yaml"))
    addDiagnostic(
      context.loader.diagnostics,
      "error",
      "invalid_module_path",
      context.source,
      "A use step must reference a .module.yaml file.",
      "Write `use: path/to/login.module.yaml`.",
    );
  const withValues = (mapping.with ?? {}) as Record<string, FlowScalar>;
  return {
    kind: "module",
    phase: context.phase,
    use: mapping.use,
    with: withValues,
    withSources: moduleArgumentSources(withValues, context),
    source: context.source,
    sourceStack: [context.source],
  };
}

function reportRun(context: StepContext): void {
  addDiagnostic(
    context.loader.diagnostics,
    "error",
    "unsupported_run",
    context.source,
    "The run step is not supported by the v1 loader.",
    "Use a sentence step; SED-11 will define user-code steps.",
  );
}

function isMapping(item: unknown): item is Record<string, unknown> {
  if (item === null) return false;
  if (typeof item !== "object") return false;
  return !Array.isArray(item);
}

function parseStep(item: unknown, context: StepContext): FlowStep | null {
  if (typeof item === "string") {
    if (!item.trim()) return null;
    return parseSentence(item, context);
  }
  if (!isMapping(item)) return null;
  if ("run" in item) {
    reportRun(context);
    return null;
  }
  return parseModuleStep(item, context);
}

function stepContext(input: StepsInput, index: number): StepContext {
  return {
    phase: input.phase,
    index,
    source: sourceAt(input.loader, [input.phase, index]),
    loader: input.loader,
    knownData: input.knownData,
  };
}

export function parseSteps(input: StepsInput): FlowStep[] {
  if (!Array.isArray(input.raw)) return [];
  return input.raw.flatMap((item, index) => {
    const step = parseStep(item, stepContext(input, index));
    return step ? [step] : [];
  });
}
