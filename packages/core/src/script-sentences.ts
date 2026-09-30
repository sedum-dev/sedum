import type { FlowDiagnostic, FlowSource } from "./flow-types.js";

/** A literal step sentence written in a `*.test.ts` file. */
export interface ScriptSentence {
  readonly text: string;
  readonly source: FlowSource;
}

export interface ScriptSentenceScan {
  readonly sentences: readonly ScriptSentence[];
  /** Sentences built at run time; they cannot be checked before a run. */
  readonly warnings: readonly FlowDiagnostic[];
}

type Token =
  | {
      readonly kind: "ident" | "punct";
      readonly value: string;
      readonly line: number;
      readonly col: number;
    }
  | {
      readonly kind: "string";
      readonly value: string;
      /** A template literal with `${}` has no single value. */
      readonly dynamic: boolean;
      readonly line: number;
      readonly col: number;
    };

const IDENT_START = /[A-Za-z_$]/u;
const IDENT_PART = /[A-Za-z0-9_$]/u;
/** After these a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
  "=>",
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/** A small JavaScript lexer: enough to find string arguments of `ai` calls. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let col = 1;
  const advance = (count = 1) => {
    for (let step = 0; step < count && index < source.length; step++) {
      if (source[index] === "\n") {
        line++;
        col = 1;
      } else col++;
      index++;
    }
  };
  const readQuoted = (quote: string): { value: string; dynamic: boolean } => {
    let value = "";
    let dynamic = false;
    let depth = 0;
    advance();
    while (index < source.length) {
      const char = source[index]!;
      if (char === "\\") {
        const next = source[index + 1] ?? "";
        const hex =
          next === "x"
            ? /^[0-9A-Fa-f]{2}/u.exec(source.slice(index + 2))?.[0]
            : next === "u"
              ? (/^\{([0-9A-Fa-f]{1,6})\}/u.exec(source.slice(index + 2)) ??
                /^([0-9A-Fa-f]{4})/u.exec(source.slice(index + 2)))
              : undefined;
        if (typeof hex === "string") {
          value += String.fromCharCode(parseInt(hex, 16));
          advance(4);
        } else if (hex) {
          const code = parseInt(hex[1]!, 16);
          value += code <= 0x10ffff ? String.fromCodePoint(code) : "";
          advance(2 + hex[0].length);
        } else {
          const escapes: Record<string, string> = {
            n: "\n",
            t: "\t",
            r: "\r",
            b: "\b",
            f: "\f",
            v: "\v",
            "0": "\0",
            "\n": "",
          };
          value += escapes[next] ?? next;
          advance(2);
        }
        continue;
      }
      if (quote === "`" && char === "$" && source[index + 1] === "{") {
        dynamic = true;
        depth = 1;
        advance(2);
        while (index < source.length && depth > 0) {
          const inner = source[index]!;
          if (inner === "{") depth++;
          else if (inner === "}") depth--;
          else if (inner === '"' || inner === "'" || inner === "`") {
            readQuoted(inner);
            continue;
          }
          advance();
        }
        continue;
      }
      if (char === quote) {
        advance();
        break;
      }
      if (quote !== "`" && char === "\n") break;
      value += char;
      advance();
    }
    return { value, dynamic };
  };
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (/\s/u.test(char)) {
      advance();
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }
    if (char === "/" && next === "*") {
      advance(2);
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      )
        advance();
      advance(2);
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (char === '"' || char === "'" || char === "`") {
      const { value, dynamic } = readQuoted(char);
      tokens.push({
        kind: "string",
        value,
        dynamic,
        line: startLine,
        col: startCol,
      });
      continue;
    }
    if (char === "/") {
      const previous = tokens.at(-1);
      if (!previous || REGEX_AFTER.has(previous.value)) {
        let inClass = false;
        advance();
        while (index < source.length && source[index] !== "\n") {
          const inner = source[index]!;
          if (inner === "\\") {
            advance(2);
            continue;
          }
          if (inner === "[") inClass = true;
          else if (inner === "]") inClass = false;
          else if (inner === "/" && !inClass) {
            advance();
            break;
          }
          advance();
        }
        while (index < source.length && IDENT_PART.test(source[index]!))
          advance();
        tokens.push({
          kind: "punct",
          value: "/re/",
          line: startLine,
          col: startCol,
        });
        continue;
      }
    }
    if (IDENT_START.test(char)) {
      let value = "";
      while (index < source.length && IDENT_PART.test(source[index]!)) {
        value += source[index]!;
        advance();
      }
      tokens.push({ kind: "ident", value, line: startLine, col: startCol });
      continue;
    }
    if (char === "=" && next === ">") {
      advance(2);
      tokens.push({
        kind: "punct",
        value: "=>",
        line: startLine,
        col: startCol,
      });
      continue;
    }
    advance();
    tokens.push({ kind: "punct", value: char, line: startLine, col: startCol });
  }
  return tokens;
}

/**
 * Find the literal sentences passed to `ai(...)`, `ai([...])`, and
 * `ai.group(name, [...])`. A sentence built with `${}` or `+` is reported as
 * a warning: it defeats the classification cache and cannot be checked
 * before a run. `ai.extract` takes a description, not a step, so it is skipped.
 */
export function scanScriptSentences(
  source: string,
  file: string,
): ScriptSentenceScan {
  const tokens = tokenize(source);
  const sentences: ScriptSentence[] = [];
  const warnings: FlowDiagnostic[] = [];
  const at = (index: number) => tokens[index];
  const isPunct = (index: number, value: string) =>
    at(index)?.kind === "punct" && at(index)!.value === value;
  const dynamic = (token: Token) =>
    warnings.push({
      severity: "warning",
      code: "dynamic_sentence",
      source: { file, line: token.line, col: token.col },
      message:
        "This step sentence is built at run time, so it cannot be checked before a run and is classified again for every value.",
      fix: 'Write a literal sentence with {{name}} and pass the value separately: ai("type {{email}} into the Email field", { email }).',
    });
  /** One argument starting at `index`; returns the index after it. */
  const argument = (index: number): number => {
    const token = at(index);
    if (!token) return index;
    if (token.kind === "string") {
      const following = at(index + 1);
      const ends =
        following?.kind === "punct" &&
        (following.value === "," ||
          following.value === ")" ||
          following.value === "]");
      if (token.dynamic || !ends) dynamic(token);
      else
        sentences.push({
          text: token.value,
          source: { file, line: token.line, col: token.col },
        });
      return index + 1;
    }
    return index;
  };
  const list = (index: number): void => {
    // `[` at index: literal elements separated by commas.
    let cursor = index + 1;
    while (cursor < tokens.length && !isPunct(cursor, "]")) {
      const after = argument(cursor);
      cursor = after === cursor ? cursor + 1 : after;
    }
  };
  const call = (open: number): void => {
    const first = open + 1;
    if (isPunct(first, "[")) list(first);
    else argument(first);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "ident" || token.value !== "ai") continue;
    if (isPunct(index - 1, ".")) continue;
    if (isPunct(index + 1, "(")) {
      call(index + 1);
      continue;
    }
    if (
      isPunct(index + 1, ".") &&
      at(index + 2)?.kind === "ident" &&
      at(index + 2)!.value === "group" &&
      isPunct(index + 3, "(")
    ) {
      // ai.group("name", [...sentences]) — the name is not a step.
      let cursor = index + 4;
      if (at(cursor)?.kind === "string") cursor++;
      if (isPunct(cursor, ",") && isPunct(cursor + 1, "[")) list(cursor + 1);
    }
  }
  return { sentences, warnings };
}
