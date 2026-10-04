import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  type Pair,
} from "yaml";
import type { FlowDiagnostic, FlowSource } from "./flow-types.js";

export type KeyPath = readonly (string | number)[];

export interface LoaderContext {
  readonly file: string;
  readonly counter: LineCounter;
  readonly nodes: Map<string, Node>;
  readonly diagnostics: FlowDiagnostic[];
}

export function createLoaderContext(
  file: string,
  diagnostics: FlowDiagnostic[] = [],
): LoaderContext {
  return {
    file,
    counter: new LineCounter(),
    nodes: new Map<string, Node>(),
    diagnostics,
  };
}

export function addDiagnostic(
  diagnostics: FlowDiagnostic[],
  severity: FlowDiagnostic["severity"],
  code: string,
  source: FlowSource,
  message: string,
  fix: string,
): void {
  diagnostics.push({ severity, code, source, message, fix });
}

export function compareDiagnostics(
  left: FlowDiagnostic,
  right: FlowDiagnostic,
): number {
  return (
    left.source.file.localeCompare(right.source.file) ||
    left.source.line - right.source.line ||
    left.source.col - right.source.col ||
    left.code.localeCompare(right.code)
  );
}

export function sourcePosition(
  context: LoaderContext,
  node?: Node | null,
): FlowSource {
  const position = context.counter.linePos(node?.range?.[0] ?? 0);
  return { file: context.file, line: position.line, col: position.col };
}

export function sourceAt(context: LoaderContext, parts: KeyPath): FlowSource {
  let candidate: Node | undefined;
  for (let end = parts.length; end >= 0; end--) {
    candidate = context.nodes.get(JSON.stringify(parts.slice(0, end)));
    if (candidate) break;
  }
  return sourcePosition(context, candidate);
}

function reportNestingLimit(context: LoaderContext, node: Node): void {
  addDiagnostic(
    context.diagnostics,
    "error",
    "yaml_nesting_limit",
    sourcePosition(context, node),
    "This YAML value is nested too deeply.",
    "Keep test structure within 64 mapping/list levels.",
  );
}

function reportAlias(context: LoaderContext, node: Node): void {
  addDiagnostic(
    context.diagnostics,
    "error",
    "unsupported_alias",
    sourcePosition(context, node),
    "YAML aliases are not supported in a test file.",
    "Write the value directly instead of using an alias.",
  );
}

function reportTag(context: LoaderContext, node: Node): void {
  addDiagnostic(
    context.diagnostics,
    "error",
    "unsupported_tag",
    sourcePosition(context, node),
    `Unsupported YAML tag ${node.tag}.`,
    "Use ordinary YAML scalars, mappings, and lists.",
  );
}

function isSupportedTag(node: Node): boolean {
  return (
    !node.tag ||
    /^tag:yaml\.org,2002:(?:str|int|float|bool|null|map|seq)$/.test(node.tag)
  );
}

function reportInvalidKey(context: LoaderContext, pair: Pair): void {
  addDiagnostic(
    context.diagnostics,
    "error",
    "invalid_mapping_key",
    sourcePosition(context, isNode(pair.key) ? pair.key : undefined),
    "Mapping keys must be strings.",
    "Write a plain text key followed by a colon.",
  );
}

function decodeMapping(
  node: Extract<Node, { items: unknown[] }>,
  parts: KeyPath,
  context: LoaderContext,
  depth: number,
): Record<string, unknown> {
  const object: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const pair of node.items as Pair[]) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      reportInvalidKey(context, pair);
      continue;
    }
    const key = pair.key.value;
    context.nodes.set(JSON.stringify([...parts, key, "$key"]), pair.key);
    object[key] = decodeNode(pair.value, [...parts, key], context, depth + 1);
  }
  return object;
}

export function decodeNode(
  node: unknown,
  parts: KeyPath,
  context: LoaderContext,
  depth = 0,
): unknown {
  if (!isNode(node)) return null;
  context.nodes.set(JSON.stringify(parts), node);
  if (depth > 64) {
    reportNestingLimit(context, node);
    return null;
  }
  if (isAlias(node)) {
    reportAlias(context, node);
    return null;
  }
  if (!isSupportedTag(node)) {
    reportTag(context, node);
    return null;
  }
  if (isScalar(node)) return node.value;
  if (isSeq(node))
    return node.items.map((child, index) =>
      decodeNode(child, [...parts, index], context, depth + 1),
    );
  if (isMap(node)) return decodeMapping(node, parts, context, depth);
  return null;
}
