/** Source positions come from YAML nodes, never from searching the source text. */
export interface FlowSource {
  readonly file: string;
  readonly line: number;
  readonly col: number;
}

export interface FlowDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly source: FlowSource;
  readonly message: string;
  readonly fix: string;
}

export type FlowScalar = string | number | boolean | null;

export interface DeclaredDataValue {
  readonly value: FlowScalar;
  readonly source: FlowSource;
}

export interface FlowToken {
  readonly kind: "placeholder" | "quoted";
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly key?: string;
}

export interface SentenceStep {
  readonly kind: "sentence";
  readonly phase: "before" | "steps" | "after";
  readonly text: string;
  readonly tokens: readonly FlowToken[];
  readonly source: FlowSource;
  /** SED-29 adds module call sites before the sentence source. */
  readonly sourceStack?: readonly FlowSource[];
}

export interface ModuleBinding {
  readonly value: FlowScalar;
  readonly source: FlowSource;
}

export interface ModuleStep {
  readonly kind: "module";
  readonly phase: "before" | "steps" | "after";
  readonly use: string;
  readonly with: Readonly<Record<string, FlowScalar>>;
  readonly withSources: Readonly<Record<string, FlowSource>>;
  readonly source: FlowSource;
  /** SED-29 adds each resolved module source after this call site. */
  readonly sourceStack: readonly FlowSource[];
  /** Present only after the complete module graph has been resolved. */
  readonly resolved?: ResolvedModuleCall;
}

export interface ResolvedModuleCall {
  readonly id: string;
  readonly file: string;
  readonly parameters: readonly string[];
  readonly bindings: Readonly<Record<string, ModuleBinding>>;
  readonly steps: readonly FlowStep[];
}

export type FlowStep = SentenceStep | ModuleStep;

export interface FlowDefinition {
  readonly version: 1;
  readonly file: string;
  readonly identity: string;
  readonly explicitId?: string;
  readonly idSource?: FlowSource;
  readonly description?: string;
  readonly url?: string;
  readonly tags: readonly string[];
  readonly meta: Readonly<Record<string, unknown>>;
  readonly data: Readonly<Record<string, DeclaredDataValue>>;
  readonly before: readonly FlowStep[];
  readonly steps: readonly FlowStep[];
  readonly after: readonly FlowStep[];
}

export interface ModuleDefinition {
  readonly file: string;
  readonly source: FlowSource;
  readonly parameters: readonly string[];
  readonly steps: readonly FlowStep[];
}

export interface ParsedModuleResult {
  readonly value?: ModuleDefinition;
  readonly diagnostics: readonly FlowDiagnostic[];
}

/** A format-only result cannot be mistaken for full validation. */
export interface FormatCoverage {
  readonly format: "passed" | "failed";
  readonly steps: "not_checked";
  readonly modules: "not_needed" | "not_checked";
}

export interface ParsedFlowResult {
  readonly value?: FlowDefinition;
  /** Parsed steps retained only for collecting later errors; never executable. */
  readonly candidate?: FlowDefinition;
  readonly diagnostics: readonly FlowDiagnostic[];
  readonly coverage: FullValidationCoverage;
}

export interface ValidationInput {
  readonly source: string;
  readonly path: string;
}

export interface FlowValidationResult {
  readonly files: readonly ParsedFlowResult[];
  readonly diagnostics: readonly FlowDiagnostic[];
  readonly coverage: FormatCoverage;
}

/** SED-28/29/37 may only mark checks complete after actually performing them. */
export interface FullValidationCoverage {
  readonly format: "passed" | "failed";
  readonly steps: "not_checked" | "checked" | "incomplete";
  readonly modules: "not_needed" | "not_checked" | "checked" | "incomplete";
}

export function isFullyValidated(
  coverage: FullValidationCoverage,
  diagnostics: readonly FlowDiagnostic[],
): boolean {
  return (
    coverage.format === "passed" &&
    coverage.steps === "checked" &&
    (coverage.modules === "not_needed" || coverage.modules === "checked") &&
    !diagnostics.some((diagnostic) => diagnostic.severity === "error")
  );
}

export function formatFlowDiagnostic(diagnostic: FlowDiagnostic): string {
  const { file, line, col } = diagnostic.source;
  return `${file}:${line}:${col}: ${diagnostic.message} ${diagnostic.fix}`;
}
