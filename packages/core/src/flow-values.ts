import { RuntimeValue } from "./step-executor.js";
import type {
  DeclaredDataValue,
  FlowDiagnostic,
  ModuleBinding,
  FlowScalar,
  FlowToken,
  SentenceStep,
} from "./flow-types.js";

interface TemplatePart {
  readonly literal?: string;
  readonly variable?: string;
}

export interface ResolvedDataEntry {
  readonly value: RuntimeValue;
  readonly sensitive: boolean;
  /** A page-observed value may be used in Judge claims; environment values may not. */
  readonly modelVisible?: boolean;
  /** Opaque environment components used only for attempt-local taint checks. */
  readonly opaqueValues?: readonly RuntimeValue[];
}

/** A page echo of an environment value is still environment-derived. */
export function opaqueMatches(
  text: string,
  entries: readonly ResolvedDataEntry[],
): readonly RuntimeValue[] {
  return entries
    .flatMap((entry) => entry.opaqueValues ?? [])
    .filter(
      (value) => value.reveal().length > 0 && text.includes(value.reveal()),
    );
}

/** Project text to a model without sending attempt-known environment components. */
export function redactOpaqueText(
  text: string,
  entries: readonly ResolvedDataEntry[],
): string {
  const values = [
    ...new Set(
      entries
        .flatMap((entry) => entry.opaqueValues ?? [])
        .map((value) => value.reveal())
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  return values.reduce(
    (safe, value) => safe.replaceAll(value, "[sensitive]"),
    text,
  );
}

export class DataResolutionError extends Error {
  readonly code = "missing_environment_variable";

  constructor(dataKey: string, variable: string, declared: DeclaredDataValue) {
    const { file, line, col } = declared.source;
    super(
      `${file}:${line}:${col}: data.${dataKey} needs $${variable}, which is not set`,
    );
    this.name = "DataResolutionError";
  }
}

export class ModuleBindingResolutionError extends Error {
  constructor(
    readonly code: "missing_module_binding" | "missing_environment_variable",
    readonly outcome: "failed" | "error",
    readonly source: ModuleBinding["source"],
    message: string,
  ) {
    super(`${source.file}:${source.line}:${source.col}: ${message}`);
    this.name = "ModuleBindingResolutionError";
  }
}

/** The template language is deliberately limited to $VAR, ${VAR}, and $$. */
export function parseDataTemplate(
  value: string,
): { readonly parts: readonly TemplatePart[] } | { readonly error: string } {
  const parts: TemplatePart[] = [];
  let literal = "";
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character !== "$") {
      literal += character;
      index++;
      continue;
    }
    const next = value[index + 1];
    if (next === "$") {
      literal += "$";
      index += 2;
      continue;
    }
    let variable: string | undefined;
    if (next === "{") {
      const end = value.indexOf("}", index + 2);
      if (end < 0)
        return {
          error: "Close ${VAR} with } or write $$ for a literal dollar.",
        };
      variable = value.slice(index + 2, end);
      index = end + 1;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(index + 1));
      if (!match)
        return {
          error:
            "Use $VAR or ${VAR} for an environment value, or $$ for a literal dollar.",
        };
      variable = match[0];
      index += match[0].length + 1;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
      return {
        error:
          "Environment variable names use letters, digits, and underscores, starting with a letter or underscore.",
      };
    if (literal) parts.push({ literal });
    literal = "";
    parts.push({ variable });
  }
  if (literal) parts.push({ literal });
  return { parts };
}

export function resolveData(
  declared: Readonly<Record<string, DeclaredDataValue>>,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, ResolvedDataEntry>> {
  const resolved: Record<string, ResolvedDataEntry> = Object.create(
    null,
  ) as Record<string, ResolvedDataEntry>;
  for (const [key, item] of Object.entries(declared)) {
    if (typeof item.value !== "string") {
      resolved[key] = {
        value: new RuntimeValue(String(item.value), `{{${key}}}`),
        sensitive: false,
      };
      continue;
    }
    const parsed = parseDataTemplate(item.value);
    if ("error" in parsed)
      throw new Error(
        `${item.source.file}:${item.source.line}:${item.source.col}: data.${key}: ${parsed.error}`,
      );
    let text = "";
    let sensitive = false;
    const opaqueValues: RuntimeValue[] = [];
    for (const part of parsed.parts) {
      if (part.literal !== undefined) text += part.literal;
      if (part.variable !== undefined) {
        const value = env[part.variable];
        if (!Object.hasOwn(env, part.variable) || typeof value !== "string")
          throw new DataResolutionError(key, part.variable, item);
        text += value;
        sensitive = true;
        opaqueValues.push(new RuntimeValue(value, `{{${key}}}`));
      }
    }
    resolved[key] = {
      value: new RuntimeValue(text, `{{${key}}}`),
      sensitive,
      opaqueValues,
    };
  }
  return resolved;
}

/** Resolve one reached module occurrence against its live caller scope. */
export function resolveModuleBindings(
  parameters: readonly string[],
  bindings: Readonly<Record<string, ModuleBinding>>,
  caller: Readonly<Record<string, ResolvedDataEntry>>,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, ResolvedDataEntry>> {
  const resolved: Record<string, ResolvedDataEntry> = Object.create(
    null,
  ) as Record<string, ResolvedDataEntry>;
  const substitute = (
    literal: string,
    binding: ModuleBinding,
  ): {
    text: string;
    sensitive: boolean;
    modelVisible: boolean;
    remembered: boolean;
    opaqueValues: readonly RuntimeValue[];
  } => {
    let sensitive = false;
    let modelVisible = true;
    let remembered = false;
    const opaqueValues: RuntimeValue[] = [];
    const text = literal.replace(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
      (_whole, key: string) => {
        const found = caller[key];
        if (!found)
          throw new ModuleBindingResolutionError(
            "missing_module_binding",
            "failed",
            binding.source,
            `module argument needs {{${key}}}, which is unavailable in this attempt`,
          );
        sensitive ||= found.sensitive;
        modelVisible &&= !found.sensitive || found.modelVisible === true;
        remembered ||= found.modelVisible === true;
        opaqueValues.push(...(found.opaqueValues ?? []));
        return found.value.reveal();
      },
    );
    return { text, sensitive, modelVisible, remembered, opaqueValues };
  };
  for (const parameter of parameters) {
    const binding = bindings[parameter];
    if (!binding)
      throw new ModuleBindingResolutionError(
        "missing_module_binding",
        "failed",
        { file: "module", line: 1, col: 1 },
        `module argument ${parameter} is unavailable`,
      );
    if (typeof binding.value !== "string") {
      resolved[parameter] = {
        value: new RuntimeValue(String(binding.value), `{{${parameter}}}`),
        sensitive: false,
      };
      continue;
    }
    const parsed = parseDataTemplate(binding.value);
    if ("error" in parsed)
      throw new ModuleBindingResolutionError(
        "missing_module_binding",
        "failed",
        binding.source,
        parsed.error,
      );
    let text = "";
    let sensitive = false;
    let modelVisible = true;
    let remembered = false;
    const opaqueValues: RuntimeValue[] = [];
    for (const part of parsed.parts) {
      if (part.literal !== undefined) {
        const replaced = substitute(part.literal, binding);
        text += replaced.text;
        sensitive ||= replaced.sensitive;
        modelVisible &&= replaced.modelVisible;
        remembered ||= replaced.remembered;
        opaqueValues.push(...replaced.opaqueValues);
      }
      if (part.variable !== undefined) {
        const value = env[part.variable];
        if (!Object.hasOwn(env, part.variable) || typeof value !== "string")
          throw new ModuleBindingResolutionError(
            "missing_environment_variable",
            "error",
            binding.source,
            `module argument ${parameter} needs $${part.variable}, which is not set`,
          );
        text += value;
        sensitive = true;
        modelVisible = false;
        opaqueValues.push(new RuntimeValue(value, `{{${parameter}}}`));
      }
    }
    resolved[parameter] = {
      value: new RuntimeValue(text, `{{${parameter}}}`),
      sensitive,
      modelVisible: modelVisible && remembered,
      opaqueValues,
    };
  }
  return resolved;
}

export interface StepTokenization {
  readonly tokens: readonly FlowToken[];
  readonly problems: readonly {
    readonly code: string;
    readonly message: string;
    readonly fix: string;
  }[];
}

/** Record lexical spans while leaving the original model sentence untouched. */
export function tokenizeStep(text: string): StepTokenization {
  const tokens: FlowToken[] = [];
  const problems: { code: string; message: string; fix: string }[] = [];
  let quoteStart = -1;
  for (let index = 0; index < text.length;) {
    if (text[index] === '"' && text[index - 1] !== "\\") {
      if (quoteStart < 0) quoteStart = index;
      else {
        tokens.push({
          kind: "quoted",
          start: quoteStart,
          end: index + 1,
          text: text.slice(quoteStart + 1, index),
        });
        quoteStart = -1;
      }
      index++;
      continue;
    }
    if (text.startsWith("{{", index)) {
      const end = text.indexOf("}}", index + 2);
      const key = end < 0 ? "" : text.slice(index + 2, end).trim();
      if (end < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        problems.push({
          code: "invalid_placeholder",
          message: "Malformed placeholder.",
          fix: "Write it as {{a_data_key}} with a closing }} and a valid key name.",
        });
        index = end < 0 ? text.length : end + 2;
        continue;
      }
      tokens.push({
        kind: "placeholder",
        start: index,
        end: end + 2,
        text: text.slice(index, end + 2),
        key,
      });
      index = end + 2;
      continue;
    }
    if (text.startsWith("}}", index)) {
      problems.push({
        code: "invalid_placeholder",
        message: "Unexpected }} in step.",
        fix: "Remove it or write a complete {{a_data_key}} placeholder.",
      });
      index += 2;
      continue;
    }
    index++;
  }
  if (quoteStart >= 0)
    problems.push({
      code: "unclosed_quote",
      message: "Unclosed double-quoted literal.",
      fix: 'Close the literal with ".',
    });
  return { tokens: tokens.sort((a, b) => a.start - b.start), problems };
}

/** SED-28 calls this only after classifying a sentence as `type`. */
export function validateTypeOperand(
  step: SentenceStep,
): { readonly operand: FlowToken } | { readonly diagnostic: FlowDiagnostic } {
  const quotes = step.tokens.filter((token) => token.kind === "quoted");
  const candidates = step.tokens.filter(
    (token) =>
      token.kind === "quoted" ||
      !quotes.some(
        (quote) => quote.start < token.start && token.end < quote.end,
      ),
  );
  let targetStart = step.text.length;
  for (const match of step.text.matchAll(/\b(?:in|into)\b/gi)) {
    const start = match.index;
    if (
      !step.tokens.some((token) => token.start <= start && start < token.end)
    ) {
      targetStart = start;
      break;
    }
  }
  const values = candidates.filter((token) => token.start < targetStart);
  if (values.length === 1) return { operand: values[0]! };
  return {
    diagnostic: {
      severity: "error",
      code: values.length ? "ambiguous_type_value" : "missing_type_value",
      source: step.source,
      message: values.length
        ? "This type step names more than one value."
        : "This type step names no value.",
      fix: values.length
        ? "Use one {{data_key}} or one double-quoted literal per type step."
        : 'Write the value as {{a_data_key}} or in "double quotes".',
    },
  };
}

/** The executor may reveal this opaque value; reports and models see its label. */
export function resolveTypeOperand(
  operand: FlowToken,
  data: Readonly<Record<string, ResolvedDataEntry>>,
): RuntimeValue {
  if (operand.kind === "placeholder") {
    const found = data[operand.key!];
    if (!found) throw new RangeError(`Unknown data key ${operand.key}`);
    return found.value;
  }
  const text = operand.text.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_, key: string) => {
      const found = data[key];
      if (!found) throw new RangeError(`Unknown data key ${key}`);
      return found.value.reveal();
    },
  );
  return new RuntimeValue(text);
}

export function isFlowScalar(value: unknown): value is FlowScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
