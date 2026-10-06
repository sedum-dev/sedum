import { tokenize } from "./scanner.js";

/** Return the outermost call beginning on the requested source line. */
export function callExtent(
  source: string,
  line: number,
): { readonly start: number; readonly end: number } | undefined {
  const tokens = tokenize(source);
  const open: number[] = [];
  let best: number | undefined;
  tokens.forEach((token, index) => {
    if (token.kind !== "punct") return;
    if (isOpening(token.value)) {
      open.push(index);
      return;
    }
    if (!isClosing(token.value)) return;
    const opener = open.pop();
    if (!closesCallOnLine(tokens, opener, line)) return;
    if (best === undefined || token.line > tokens[best]!.line) best = index;
  });
  return best === undefined
    ? undefined
    : { start: line, end: tokens[best]!.line };
}

function isOpening(value: string): boolean {
  return "([{".includes(value);
}

function isClosing(value: string): boolean {
  return ")]}".includes(value);
}

function closesCallOnLine(
  tokens: ReturnType<typeof tokenize>,
  opener: number | undefined,
  line: number,
): opener is number {
  if (opener === undefined) return false;
  if (tokens[opener]?.value !== "(") return false;
  if (tokens[opener]?.line !== line) return false;
  return tokens[opener - 1]?.kind === "ident";
}
