import { tokenize, type Token } from "./scanner.js";

type SpecifierReader = (
  tokens: readonly Token[],
  index: number,
) => Token | undefined;

const SPECIFIER_READERS: Readonly<Record<string, SpecifierReader>> = {
  from: (tokens, index) => tokens[index + 1],
  import: (tokens, index) => callArgument(tokens, index) ?? tokens[index + 1],
  require: callArgument,
};

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
  return SPECIFIER_READERS[token.value]?.(tokens, index);
}

function callArgument(
  tokens: readonly Token[],
  index: number,
): Token | undefined {
  return tokens[index + 1]?.value === "(" ? tokens[index + 2] : undefined;
}

function isLocalStaticString(
  token: Token | undefined,
): token is Token & { readonly kind: "string" } {
  if (token?.kind !== "string" || token.dynamic) return false;
  return /^\.\.?\//u.test(token.value);
}
