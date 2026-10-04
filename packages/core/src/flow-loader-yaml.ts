import { isMap, parseDocument, type YAMLMap } from "yaml";
import {
  addDiagnostic,
  sourcePosition,
  type LoaderContext,
} from "./flow-loader-context.js";

type DocumentKind = "flow" | "module";

const rootDiagnostics = {
  flow: {
    code: "invalid_root",
    message: "A test file must be a mapping.",
    fix: "Start with keys such as `url`, `data`, and `steps`.",
  },
  module: {
    code: "invalid_module_root",
    message: "A module file must be a mapping.",
    fix: "Start with `parameters:` and `steps:`.",
  },
} as const;

function reportSyntaxFailure(context: LoaderContext, kind: DocumentKind): void {
  addDiagnostic(
    context.diagnostics,
    "error",
    "yaml_syntax",
    { file: context.file, line: 1, col: 1 },
    kind === "flow"
      ? "Could not parse this YAML file."
      : "Could not parse this YAML module.",
    "Correct the YAML syntax.",
  );
}

function parseYaml(source: string, context: LoaderContext) {
  return parseDocument(source, {
    lineCounter: context.counter,
    uniqueKeys: true,
    strict: true,
  });
}

function reportDocumentErrors(
  context: LoaderContext,
  errors: ReturnType<typeof parseDocument>["errors"],
): void {
  for (const error of errors) {
    const position = context.counter.linePos(error.pos[0]);
    const duplicate = error.code === "DUPLICATE_KEY";
    addDiagnostic(
      context.diagnostics,
      "error",
      duplicate ? "duplicate_key" : "yaml_syntax",
      { file: context.file, line: position.line, col: position.col },
      error.message.split("\n")[0] ?? "Invalid YAML.",
      duplicate
        ? "Keep only one occurrence of this key."
        : "Correct the YAML syntax.",
    );
  }
}

function reportInvalidRoot(context: LoaderContext, kind: DocumentKind): void {
  const diagnostic = rootDiagnostics[kind];
  addDiagnostic(
    context.diagnostics,
    "error",
    diagnostic.code,
    sourcePosition(context),
    diagnostic.message,
    diagnostic.fix,
  );
}

export function parseMappingDocument(
  source: string,
  context: LoaderContext,
  kind: DocumentKind,
): YAMLMap | null {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseYaml(source, context);
  } catch {
    reportSyntaxFailure(context, kind);
    return null;
  }
  reportDocumentErrors(context, document.errors);
  if (document.errors.length > 0) return null;
  if (!isMap(document.contents)) {
    reportInvalidRoot(context, kind);
    return null;
  }
  return document.contents;
}
