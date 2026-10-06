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
