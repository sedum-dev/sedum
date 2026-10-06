import { tokenize, type Token } from "./scanner.js";

/** Relative module specifiers referenced by static and dynamic imports. */
export function scanLocalImports(source: string): readonly string[] {
  const tokens = tokenize(source);
  const found = new Set<string>();
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const after = tokens[index + 2];
    const specifier = importSpecifier(token, next, after);
    if (
      specifier?.kind === "string" &&
      !specifier.dynamic &&
      /^\.\.?\//u.test(specifier.value)
    )
      found.add(specifier.value);
  });
  return [...found];
}

function importSpecifier(
  token: Token,
  next: Token | undefined,
  after: Token | undefined,
): Token | undefined {
  if (token.kind === "ident" && token.value === "from") return next;
  if (token.kind === "ident" && token.value === "import")
    return next?.kind === "punct" && next.value === "(" ? after : next;
  if (
    token.kind === "ident" &&
    token.value === "require" &&
    next?.kind === "punct" &&
    next.value === "("
  )
    return after;
  return undefined;
}

export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
}

/** Named and default imports from one token stream. */
export function scanImportBindings(source: string): readonly ImportBinding[] {
  const tokens = tokenize(source);
  const bindings: ImportBinding[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "ident" || token.value !== "import") return;
    bindings.push(...bindingsAt(tokens, index));
  });
  return bindings;
}

function bindingsAt(tokens: readonly Token[], index: number): ImportBinding[] {
  const names: { local: string; imported: string }[] = [];
  const afterType = skipTypeKeyword(tokens, index + 1);
  const cursor = readDefaultImport(tokens, afterType, names);
  const afterNames =
    tokens[cursor]?.value === "{"
      ? readNamedImports(tokens, cursor, names)
      : cursor;
  const from = tokens[afterNames];
  const specifier = tokens[afterNames + 1];
  if (
    from?.kind !== "ident" ||
    from.value !== "from" ||
    specifier?.kind !== "string" ||
    specifier.dynamic
  )
    return [];
  return names.map((name) => ({ ...name, specifier: specifier.value }));
}

function skipTypeKeyword(tokens: readonly Token[], cursor: number): number {
  const token = tokens[cursor];
  return token?.kind === "ident" && token.value === "type"
    ? cursor + 1
    : cursor;
}

function readDefaultImport(
  tokens: readonly Token[],
  cursor: number,
  names: { local: string; imported: string }[],
): number {
  const token = tokens[cursor];
  if (token?.kind !== "ident" || token.value === "from") return cursor;
  names.push({ local: token.value, imported: "default" });
  const next = cursor + 1;
  return tokens[next]?.value === "," ? next + 1 : next;
}

function readNamedImports(
  tokens: readonly Token[],
  open: number,
  names: { local: string; imported: string }[],
): number {
  let cursor = open + 1;
  while (cursor < tokens.length && tokens[cursor]?.value !== "}") {
    const name = tokens[cursor];
    if (name?.kind !== "ident" || name.value === "type") {
      cursor++;
      continue;
    }
    cursor = readNamedImport(tokens, cursor, name.value, names);
  }
  return cursor + 1;
}

function readNamedImport(
  tokens: readonly Token[],
  cursor: number,
  imported: string,
  names: { local: string; imported: string }[],
): number {
  const local = tokens[cursor + 2];
  if (tokens[cursor + 1]?.value === "as" && local?.kind === "ident") {
    names.push({ local: local.value, imported });
    return cursor + 3;
  }
  names.push({ local: imported, imported });
  return cursor + 1;
}
