import { tokenize, type Token } from "./scanner.js";

/** Relative module specifiers referenced by static and dynamic imports. */
export function scanLocalImports(source: string): readonly string[] {
  const tokens = tokenize(source);
  const found = new Set<string>();
  tokens.forEach((token, index) => {
    const specifier = importSpecifier(tokens, token, index);
    if (isLocalStaticString(specifier)) found.add(specifier.value);
  });
  return [...found];
}

function importSpecifier(
  tokens: readonly Token[],
  token: Token,
  index: number,
): Token | undefined {
  if (token.kind !== "ident") return undefined;
  const next = tokens[index + 1];
  switch (token.value) {
    case "from":
      return next;
    case "import":
      return next?.value === "(" ? tokens[index + 2] : next;
    case "require":
      return next?.value === "(" ? tokens[index + 2] : undefined;
    default:
      return undefined;
  }
}

function isLocalStaticString(
  token: Token | undefined,
): token is Token & { readonly kind: "string" } {
  if (token?.kind !== "string" || token.dynamic) return false;
  return /^\.\.?\//u.test(token.value);
}

export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
}

interface ImportName {
  readonly local: string;
  readonly imported: string;
}

/** Named and default imports from one token stream. */
export function scanImportBindings(source: string): readonly ImportBinding[] {
  const tokens = tokenize(source);
  return tokens.flatMap((token, index) =>
    token.kind === "ident" && token.value === "import"
      ? new ImportReader(tokens, index + 1).read()
      : [],
  );
}

class ImportReader {
  private readonly names: ImportName[] = [];
  private cursor: number;

  constructor(
    private readonly tokens: readonly Token[],
    start: number,
  ) {
    this.cursor = start;
  }

  read(): ImportBinding[] {
    this.skipTypeKeyword();
    this.readDefault();
    this.readNamed();
    return this.bindNames();
  }

  private skipTypeKeyword(): void {
    if (this.currentIdentifier() === "type") this.cursor++;
  }

  private readDefault(): void {
    const name = this.currentIdentifier();
    if (!name || name === "from") return;
    this.names.push({ local: name, imported: "default" });
    this.cursor++;
    if (this.currentValue() === ",") this.cursor++;
  }

  private readNamed(): void {
    if (this.currentValue() !== "{") return;
    this.cursor++;
    while (this.cursor < this.tokens.length && this.currentValue() !== "}")
      this.readNamedEntry();
    this.cursor++;
  }

  private readNamedEntry(): void {
    const imported = this.currentIdentifier();
    if (!imported || imported === "type") {
      this.cursor++;
      return;
    }
    const local = this.identifierAt(this.cursor + 2);
    if (this.tokens[this.cursor + 1]?.value === "as" && local) {
      this.names.push({ local, imported });
      this.cursor += 3;
      return;
    }
    this.names.push({ local: imported, imported });
    this.cursor++;
  }

  private bindNames(): ImportBinding[] {
    const from = this.currentIdentifier();
    const specifier = this.tokens[this.cursor + 1];
    if (from !== "from" || specifier?.kind !== "string" || specifier.dynamic)
      return [];
    return this.names.map((name) => ({ ...name, specifier: specifier.value }));
  }

  private currentValue(): string | undefined {
    return this.tokens[this.cursor]?.value;
  }

  private currentIdentifier(): string | undefined {
    return this.identifierAt(this.cursor);
  }

  private identifierAt(index: number): string | undefined {
    const token = this.tokens[index];
    return token?.kind === "ident" ? token.value : undefined;
  }
}
