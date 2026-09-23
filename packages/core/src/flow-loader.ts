import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { walkSuiteFiles } from "./project-discovery.js";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
} from "yaml";
import {
  isFlowScalar,
  parseDataTemplate,
  tokenizeStep,
} from "./flow-values.js";
import type {
  DeclaredDataValue,
  FlowDefinition,
  FlowDiagnostic,
  FlowScalar,
  FlowSource,
  FlowStep,
  FlowValidationResult,
  ModuleDefinition,
  ParsedModuleResult,
  ParsedFlowResult,
  ValidationInput,
} from "./flow-types.js";

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
/** Additional optional fields may be added without changing the v1 marker. */
const v1Schema = z.strictObject({
  sedum: z.literal(1).optional(),
  id: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  url: z.string().min(1).optional(),
  data: z.record(dataKeySchema, scalarSchema).optional(),
  before: z.array(stepSchema).optional(),
  steps: z.array(stepSchema).min(1),
  after: z.array(stepSchema).optional(),
  tags: z.array(z.string()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const knownKeys = [
  "sedum",
  "id",
  "description",
  "url",
  "data",
  "before",
  "steps",
  "after",
  "tags",
  "meta",
];
type KeyPath = readonly (string | number)[];

export interface ParseFlowOptions {
  /** Needed for stable, repo-relative identity when `id` is absent. */
  readonly repoRoot: string;
  /** Validation may warn about URL resolution without opening a network connection. */
  readonly baseUrl?: string;
}

function nodeKey(parts: KeyPath): string {
  return JSON.stringify(parts);
}

function position(
  file: string,
  counter: LineCounter,
  node?: Node | null,
): FlowSource {
  const pos = counter.linePos(node?.range?.[0] ?? 0);
  return { file, line: pos.line, col: pos.col };
}

function add(
  diagnostics: FlowDiagnostic[],
  severity: FlowDiagnostic["severity"],
  code: string,
  source: FlowSource,
  message: string,
  fix: string,
): void {
  diagnostics.push({ severity, code, source, message, fix });
}

function compareDiagnostics(a: FlowDiagnostic, b: FlowDiagnostic): number {
  return (
    a.source.file.localeCompare(b.source.file) ||
    a.source.line - b.source.line ||
    a.source.col - b.source.col ||
    a.code.localeCompare(b.code)
  );
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const saved = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
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
  if (key === "goal" || key === "verify")
    return `Remove top-level \`${key}\`; goal authoring is not supported in v1.`;
  const suggestion = knownKeys
    .map((known) => ({ known, score: distance(key, known) }))
    .sort((a, b) => a.score - b.score || a.known.localeCompare(b.known))[0];
  return suggestion && suggestion.score <= 2
    ? `Did you mean \`${suggestion.known}\`?`
    : `Use one of: ${knownKeys.map((known) => `\`${known}\``).join(", ")}.`;
}

function readNode(
  node: unknown,
  parts: KeyPath,
  nodes: Map<string, Node>,
  counter: LineCounter,
  file: string,
  diagnostics: FlowDiagnostic[],
  depth = 0,
): unknown {
  if (!isNode(node)) return null;
  nodes.set(nodeKey(parts), node);
  if (depth > 64) {
    add(
      diagnostics,
      "error",
      "yaml_nesting_limit",
      position(file, counter, node),
      "This YAML value is nested too deeply.",
      "Keep test structure within 64 mapping/list levels.",
    );
    return null;
  }
  if (isAlias(node)) {
    add(
      diagnostics,
      "error",
      "unsupported_alias",
      position(file, counter, node),
      "YAML aliases are not supported in a test file.",
      "Write the value directly instead of using an alias.",
    );
    return null;
  }
  if (
    node.tag &&
    !/^tag:yaml\.org,2002:(?:str|int|float|bool|null|map|seq)$/.test(node.tag)
  ) {
    add(
      diagnostics,
      "error",
      "unsupported_tag",
      position(file, counter, node),
      `Unsupported YAML tag ${node.tag}.`,
      "Use ordinary YAML scalars, mappings, and lists.",
    );
    return null;
  }
  if (isScalar(node)) return node.value;
  if (isSeq(node))
    return node.items.map((child, index) =>
      readNode(
        child,
        [...parts, index],
        nodes,
        counter,
        file,
        diagnostics,
        depth + 1,
      ),
    );
  if (isMap(node)) {
    const object: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        add(
          diagnostics,
          "error",
          "invalid_mapping_key",
          position(file, counter, isNode(pair.key) ? pair.key : undefined),
          "Mapping keys must be strings.",
          "Write a plain text key followed by a colon.",
        );
        continue;
      }
      const key = pair.key.value;
      nodes.set(nodeKey([...parts, key, "$key"]), pair.key);
      object[key] = readNode(
        pair.value,
        [...parts, key],
        nodes,
        counter,
        file,
        diagnostics,
        depth + 1,
      );
    }
    return object;
  }
  return null;
}

function at(
  file: string,
  counter: LineCounter,
  nodes: Map<string, Node>,
  parts: KeyPath,
): FlowSource {
  let candidate: Node | undefined;
  for (let end = parts.length; end >= 0; end--) {
    candidate = nodes.get(nodeKey(parts.slice(0, end)));
    if (candidate) break;
  }
  return position(file, counter, candidate);
}

function checkUrl(
  url: string,
  source: FlowSource,
  baseUrl: string | undefined,
  diagnostics: FlowDiagnostic[],
): void {
  if (
    /\s/.test(url) ||
    (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url))
  ) {
    add(
      diagnostics,
      "error",
      "invalid_url",
      source,
      "Invalid test URL.",
      "Use an HTTP(S) URL or a relative path without spaces.",
    );
    return;
  }
  try {
    new URL(url, "https://sedum.invalid/");
  } catch {
    add(
      diagnostics,
      "error",
      "invalid_url",
      source,
      "Invalid test URL.",
      "Use an HTTP(S) URL or a valid relative path.",
    );
    return;
  }
  if (baseUrl && url.startsWith("/") && !url.startsWith("//")) {
    try {
      if (new URL(baseUrl).pathname !== "/")
        add(
          diagnostics,
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
}

function checkPlaceholders(
  lexical: ReturnType<typeof tokenizeStep>,
  source: FlowSource,
  knownData: ReadonlySet<string>,
  diagnostics: FlowDiagnostic[],
  outputPlaceholderStart?: number,
): void {
  for (const problem of lexical.problems)
    add(
      diagnostics,
      "error",
      problem.code,
      source,
      problem.message,
      problem.fix,
    );
  for (const token of lexical.tokens) {
    if (
      token.kind === "placeholder" &&
      token.start !== outputPlaceholderStart &&
      !knownData.has(token.key!)
    )
      add(
        diagnostics,
        "error",
        "unknown_placeholder",
        source,
        `${token.text} is not in this test's data.`,
        `Declare \`${token.key}\` under data or correct the placeholder name.`,
      );
  }
}

function parseSteps(
  phase: "before" | "steps" | "after",
  raw: unknown,
  file: string,
  counter: LineCounter,
  nodes: Map<string, Node>,
  knownData: Set<string>,
  diagnostics: FlowDiagnostic[],
): FlowStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: FlowStep[] = [];
  for (const [index, item] of raw.entries()) {
    const source = at(file, counter, nodes, [phase, index]);
    if (typeof item === "string") {
      if (!item.trim()) continue;
      const lexical = tokenizeStep(item);
      const binding =
        /^(?:remember|capture)\b[\s\S]*\bas\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*\.?$/iu.exec(
          item.trim(),
        );
      checkPlaceholders(
        lexical,
        source,
        knownData,
        diagnostics,
        binding ? item.lastIndexOf("{{") : undefined,
      );
      if (binding) {
        const key = binding[1]!;
        if (knownData.has(key))
          add(
            diagnostics,
            "error",
            "duplicate_remember_binding",
            source,
            `{{${key}}} is already declared by data or an earlier remember step.`,
            "Choose a new binding name; remembered values cannot replace existing data.",
          );
        else knownData.add(key);
      }
      steps.push({
        kind: "sentence",
        phase,
        text: item,
        tokens: lexical.tokens,
        source,
      });
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const mapping = item as Record<string, unknown>;
      if ("run" in mapping) {
        add(
          diagnostics,
          "error",
          "unsupported_run",
          source,
          "The run step is not supported by the v1 loader.",
          "Use a sentence step; SED-11 will define user-code steps.",
        );
        continue;
      }
      if (typeof mapping.use === "string" && mapping.use) {
        if (!mapping.use.endsWith(".module.yaml"))
          add(
            diagnostics,
            "error",
            "invalid_module_path",
            source,
            "A use step must reference a .module.yaml file.",
            "Write `use: path/to/login.module.yaml`.",
          );
        const withValues = (mapping.with ?? {}) as Record<string, FlowScalar>;
        const withSources: Record<string, FlowSource> = Object.create(
          null,
        ) as Record<string, FlowSource>;
        for (const [key, value] of Object.entries(withValues)) {
          withSources[key] = at(file, counter, nodes, [
            phase,
            index,
            "with",
            key,
          ]);
          if (typeof value !== "string") continue;
          const valueSource = withSources[key]!;
          const lexical = tokenizeStep(value);
          checkPlaceholders(lexical, valueSource, knownData, diagnostics);
          const template = parseDataTemplate(value);
          if ("error" in template)
            add(
              diagnostics,
              "error",
              "invalid_env_template",
              valueSource,
              `Invalid environment template for module argument ${key}.`,
              template.error,
            );
        }
        steps.push({
          kind: "module",
          phase,
          use: mapping.use,
          with: withValues,
          withSources,
          source,
          sourceStack: [source],
        });
      }
    }
  }
  return steps;
}

export function parseFlow(
  source: string,
  file: string,
  options: ParseFlowOptions,
): ParsedFlowResult {
  const counter = new LineCounter();
  const diagnostics: FlowDiagnostic[] = [];
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      lineCounter: counter,
      uniqueKeys: true,
      strict: true,
    });
  } catch {
    add(
      diagnostics,
      "error",
      "yaml_syntax",
      { file, line: 1, col: 1 },
      "Could not parse this YAML file.",
      "Correct the YAML syntax.",
    );
    return {
      diagnostics,
      coverage: {
        format: "failed",
        steps: "not_checked",
        modules: "not_needed",
      },
    };
  }
  for (const error of document.errors) {
    const line = counter.linePos(error.pos[0]);
    add(
      diagnostics,
      "error",
      error.code === "DUPLICATE_KEY" ? "duplicate_key" : "yaml_syntax",
      { file, line: line.line, col: line.col },
      error.message.split("\n")[0] ?? "Invalid YAML.",
      error.code === "DUPLICATE_KEY"
        ? "Keep only one occurrence of this key."
        : "Correct the YAML syntax.",
    );
  }
  if (diagnostics.length)
    return {
      diagnostics: diagnostics.sort(compareDiagnostics),
      coverage: {
        format: "failed",
        steps: "not_checked",
        modules: "not_needed",
      },
    };
  if (!isMap(document.contents)) {
    add(
      diagnostics,
      "error",
      "invalid_root",
      { file, line: 1, col: 1 },
      "A test file must be a mapping.",
      "Start with keys such as `url`, `data`, and `steps`.",
    );
    return {
      diagnostics,
      coverage: {
        format: "failed",
        steps: "not_checked",
        modules: "not_needed",
      },
    };
  }
  const nodes = new Map<string, Node>();
  const plain = readNode(
    document.contents,
    [],
    nodes,
    counter,
    file,
    diagnostics,
  ) as Record<string, unknown>;
  for (const key of Object.keys(plain)) {
    if (knownKeys.includes(key)) continue;
    const reserved = key === "goal" || key === "verify";
    add(
      diagnostics,
      "error",
      reserved ? "reserved_key" : "unknown_key",
      at(file, counter, nodes, [key, "$key"]),
      `${reserved ? "Reserved" : "Unknown"} top-level key \`${key}\`.`,
      keyFix(key),
    );
    delete plain[key];
  }
  if (plain.sedum !== undefined && plain.sedum !== 1) {
    add(
      diagnostics,
      "error",
      "unsupported_version",
      at(file, counter, nodes, ["sedum"]),
      `Unsupported Sedum format version ${String(plain.sedum)}.`,
      "Use `sedum: 1` or omit the marker for v1.",
    );
    delete plain.sedum;
  }
  const parsed = v1Schema.safeParse(plain);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const parts = issue.path.map(String);
      const key = String(parts[0] ?? "root");
      const suspect = Array.isArray(plain[key])
        ? plain[key][Number(parts[1])]
        : undefined;
      if (
        suspect &&
        typeof suspect === "object" &&
        !Array.isArray(suspect) &&
        "run" in suspect
      )
        continue;
      add(
        diagnostics,
        "error",
        issue.code === "unrecognized_keys" ? "unknown_key" : "invalid_field",
        at(file, counter, nodes, parts),
        key === "steps" &&
          issue.code === "invalid_type" &&
          plain.steps === undefined
          ? "This test needs a `steps` list."
          : `Invalid \`${parts.join(".") || "test"}\`: ${issue.message}.`,
        key === "steps" && plain.steps === undefined
          ? "Add `steps:` with at least one sentence."
          : `Correct the value or shape of \`${key}\` for the v1 format.`,
      );
    }
  }
  const input = parsed.success ? parsed.data : null;
  const data: Record<string, DeclaredDataValue> = Object.create(null) as Record<
    string,
    DeclaredDataValue
  >;
  const rawData = plain.data;
  if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
    for (const [key, value] of Object.entries(rawData)) {
      if (!isFlowScalar(value)) continue;
      const valueSource = at(file, counter, nodes, ["data", key]);
      data[key] = { value, source: valueSource };
      if (typeof value === "string") {
        const template = parseDataTemplate(value);
        if ("error" in template)
          add(
            diagnostics,
            "error",
            "invalid_env_template",
            valueSource,
            `Invalid environment template for data.${key}.`,
            template.error,
          );
      } else if (typeof value === "number") {
        const node = nodes.get(nodeKey(["data", key]));
        if (node && node.range) {
          const written = source.slice(node.range[0], node.range[1]);
          if (written !== String(value))
            add(
              diagnostics,
              "warning",
              "scalar_coercion",
              valueSource,
              `YAML reads ${written} as ${String(value)} before typing.`,
              "Quote this data value if its written characters must be preserved.",
            );
        }
      }
    }
  }
  const knownData = new Set(Object.keys(data));
  const before = parseSteps(
    "before",
    plain.before,
    file,
    counter,
    nodes,
    knownData,
    diagnostics,
  );
  const steps = parseSteps(
    "steps",
    plain.steps,
    file,
    counter,
    nodes,
    knownData,
    diagnostics,
  );
  const after = parseSteps(
    "after",
    plain.after,
    file,
    counter,
    nodes,
    knownData,
    diagnostics,
  );
  if (typeof plain.url === "string")
    checkUrl(
      plain.url,
      at(file, counter, nodes, ["url"]),
      options.baseUrl,
      diagnostics,
    );
  const hasModule = [...before, ...steps, ...after].some(
    (step) => step.kind === "module",
  );
  const format = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  )
    ? "failed"
    : "passed";
  if (!input)
    return {
      diagnostics: diagnostics.sort(compareDiagnostics),
      coverage: {
        format,
        steps: "not_checked",
        modules: hasModule ? "not_checked" : "not_needed",
      },
    };
  const absolute = path.resolve(options.repoRoot, file);
  const relative = path
    .relative(path.resolve(options.repoRoot), absolute)
    .replaceAll("\\", "/");
  if (relative === ".." || relative.startsWith("../")) {
    add(
      diagnostics,
      "error",
      "file_outside_repo",
      { file, line: 1, col: 1 },
      "The test file is outside the repository root.",
      "Pass the correct repository root.",
    );
    return {
      diagnostics: diagnostics.sort(compareDiagnostics),
      coverage: {
        format: "failed",
        steps: "not_checked",
        modules: hasModule ? "not_checked" : "not_needed",
      },
    };
  }
  const result: FlowDefinition = {
    version: 1,
    file,
    identity: input.id ?? relative,
    ...(input.id === undefined
      ? {}
      : { explicitId: input.id, idSource: at(file, counter, nodes, ["id"]) }),
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...(input.url === undefined
      ? {}
      : { url: input.url, urlSource: at(file, counter, nodes, ["url"]) }),
    tags: input.tags ?? [],
    meta: input.meta ?? {},
    data,
    before,
    steps,
    after,
  };
  if (format === "failed") {
    const recoverable = new Set([
      "unknown_placeholder",
      "invalid_placeholder",
      "unclosed_quote",
      "duplicate_remember_binding",
    ]);
    return {
      ...(diagnostics
        .filter((item) => item.severity === "error")
        .every((item) => recoverable.has(item.code))
        ? { candidate: result }
        : {}),
      diagnostics: diagnostics.sort(compareDiagnostics),
      coverage: {
        format,
        steps: "not_checked",
        modules: hasModule ? "not_checked" : "not_needed",
      },
    };
  }
  return {
    value: result,
    diagnostics: diagnostics.sort(compareDiagnostics),
    coverage: {
      format: "passed",
      steps: "not_checked",
      modules: hasModule ? "not_checked" : "not_needed",
    },
  };
}

export function validateFlows(
  inputs: readonly ValidationInput[],
  options: ParseFlowOptions,
): FlowValidationResult {
  const files = inputs.map((input) =>
    parseFlow(input.source, input.path, options),
  );
  const diagnostics = files.flatMap((file) => [...file.diagnostics]);
  for (const collision of findIdentityCollisions(
    files.flatMap((file) => (file.value ? [file.value] : [])),
  ))
    diagnostics.push(collision);
  diagnostics.sort(compareDiagnostics);
  return {
    files,
    diagnostics,
    coverage: {
      format: diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "failed"
        : "passed",
      steps: "not_checked",
      modules: files.some((file) => file.coverage.modules === "not_checked")
        ? "not_checked"
        : "not_needed",
    },
  };
}

/**
 * Report tests that share an identity: two explicit ids, or an explicit id
 * equal to another test's path identity. The later file (by path) is reported.
 */
export function findIdentityCollisions(
  flows: readonly FlowDefinition[],
): readonly FlowDiagnostic[] {
  const diagnostics: FlowDiagnostic[] = [];
  const sorted = [...flows].sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
  );
  const pathIdentities = new Map<string, FlowDefinition>();
  for (const flow of sorted)
    if (flow.explicitId === undefined) pathIdentities.set(flow.identity, flow);
  const explicit = new Map<string, FlowSource>();
  for (const flow of sorted) {
    if (flow.explicitId === undefined) continue;
    const source = flow.idSource ?? { file: flow.file, line: 1, col: 1 };
    const previous = explicit.get(flow.explicitId);
    const pathOwner = pathIdentities.get(flow.explicitId);
    if (previous)
      add(
        diagnostics,
        "error",
        "duplicate_id",
        source,
        `Duplicate explicit id \`${flow.explicitId}\`; first used at ${previous.file}:${previous.line}:${previous.col}.`,
        "Give each test a unique explicit id or remove id to use the file path.",
      );
    else if (pathOwner)
      add(
        diagnostics,
        "error",
        "duplicate_id",
        source,
        `Explicit id \`${flow.explicitId}\` equals the path identity of ${pathOwner.file}.`,
        "Choose an id that is not another test's repository-relative path.",
      );
    else explicit.set(flow.explicitId, source);
  }
  return diagnostics.sort(compareDiagnostics);
}

/** Parse a strict reusable module without granting it test-level fields. */
export function parseModule(source: string, file: string): ParsedModuleResult {
  const counter = new LineCounter();
  const diagnostics: FlowDiagnostic[] = [];
  if (!file.endsWith(".module.yaml"))
    add(
      diagnostics,
      "error",
      "invalid_module_path",
      { file, line: 1, col: 1 },
      "A module file must end in .module.yaml.",
      "Rename the file with the .module.yaml suffix.",
    );
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(source, {
      lineCounter: counter,
      uniqueKeys: true,
      strict: true,
    });
  } catch {
    add(
      diagnostics,
      "error",
      "yaml_syntax",
      { file, line: 1, col: 1 },
      "Could not parse this YAML module.",
      "Correct the YAML syntax.",
    );
    return { diagnostics };
  }
  for (const error of document.errors) {
    const line = counter.linePos(error.pos[0]);
    add(
      diagnostics,
      "error",
      error.code === "DUPLICATE_KEY" ? "duplicate_key" : "yaml_syntax",
      { file, line: line.line, col: line.col },
      error.message.split("\n")[0] ?? "Invalid YAML.",
      error.code === "DUPLICATE_KEY"
        ? "Keep only one occurrence of this key."
        : "Correct the YAML syntax.",
    );
  }
  if (
    diagnostics.some(
      (item) => item.code === "yaml_syntax" || item.code === "duplicate_key",
    )
  )
    return { diagnostics: diagnostics.sort(compareDiagnostics) };
  if (!isMap(document.contents)) {
    add(
      diagnostics,
      "error",
      "invalid_module_root",
      { file, line: 1, col: 1 },
      "A module file must be a mapping.",
      "Start with `parameters:` and `steps:`.",
    );
    return { diagnostics: diagnostics.sort(compareDiagnostics) };
  }
  const nodes = new Map<string, Node>();
  const plain = readNode(
    document.contents,
    [],
    nodes,
    counter,
    file,
    diagnostics,
  ) as Record<string, unknown>;
  for (const key of Object.keys(plain)) {
    if (key === "parameters" || key === "steps") continue;
    add(
      diagnostics,
      "error",
      "unknown_module_key",
      at(file, counter, nodes, [key, "$key"]),
      `Unknown module key \`${key}\`.`,
      "Modules contain only `parameters` and `steps`.",
    );
    delete plain[key];
  }
  const parsed = moduleSchema.safeParse(plain);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const parts = issue.path.map(String);
      add(
        diagnostics,
        "error",
        issue.code === "unrecognized_keys"
          ? "unknown_module_key"
          : "invalid_module_field",
        at(file, counter, nodes, parts),
        `Invalid \`${parts.join(".") || "module"}\`: ${issue.message}.`,
        parts[0] === "steps" && plain.steps === undefined
          ? "Add `steps:` with at least one sentence."
          : "Correct the module field for the v1 format.",
      );
    }
  const parameters = Array.isArray(plain.parameters)
    ? plain.parameters.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const seen = new Set<string>();
  for (const [index, parameter] of parameters.entries()) {
    if (seen.has(parameter))
      add(
        diagnostics,
        "error",
        "duplicate_module_parameter",
        at(file, counter, nodes, ["parameters", index]),
        `Module parameter \`${parameter}\` is declared more than once.`,
        "Keep each parameter name once.",
      );
    seen.add(parameter);
  }
  const known = new Set(parameters);
  const steps = parseSteps(
    "steps",
    plain.steps,
    file,
    counter,
    nodes,
    known,
    diagnostics,
  );
  if (!parsed.success || diagnostics.some((item) => item.severity === "error"))
    return { diagnostics: diagnostics.sort(compareDiagnostics) };
  const value: ModuleDefinition = {
    file,
    source: at(file, counter, nodes, []),
    parameters: parsed.data.parameters,
    steps,
  };
  return { value, diagnostics: diagnostics.sort(compareDiagnostics) };
}

/** Sorted `*.test.yaml` files, skipping `node_modules` and dot-directories. */
export async function discoverFlowFiles(
  directory: string,
): Promise<readonly string[]> {
  return walkSuiteFiles(directory, [".test.yaml"]);
}

export async function loadFlowFile(
  file: string,
  options: ParseFlowOptions,
): Promise<ParsedFlowResult> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    const diagnostic: FlowDiagnostic = {
      severity: "error",
      code: "unreadable_file",
      source: { file, line: 1, col: 1 },
      message: "Could not read this test file.",
      fix: "Check the path and file permissions.",
    };
    return {
      diagnostics: [diagnostic],
      coverage: {
        format: "failed",
        steps: "not_checked",
        modules: "not_needed",
      },
    };
  }
  return parseFlow(source, file, options);
}
