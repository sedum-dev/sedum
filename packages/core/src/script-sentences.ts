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
        "This step sentence is not a literal, so it cannot be checked before a run, and a sentence built from values is classified again for every value.",
      fix: 'Write a literal sentence with {{name}} and pass the value separately: ai("type {{email}} into the Email field", { email }).',
    });
  const TERMINATORS = new Set([",", ")", "]", ";"]);
  /** Index of the `,` `)` `]` or `;` that ends the expression at `index`. */
  const skipExpression = (index: number): number => {
    let depth = 0;
    let cursor = index;
    for (; cursor < tokens.length; cursor++) {
      const token = tokens[cursor]!;
      if (token.kind !== "punct") continue;
      if (depth === 0 && TERMINATORS.has(token.value)) return cursor;
      if ("([{".includes(token.value)) depth++;
      else if (")]}".includes(token.value)) depth--;
    }
    return cursor;
  };
  // Bracket structure, to tell a use of a name from a binding of it.
  const match = new Map<number, number>();
  const parentOf: (number | undefined)[] = [];
  {
    const open: number[] = [];
    tokens.forEach((token, index) => {
      parentOf[index] = open.at(-1);
      if (token.kind !== "punct") return;
      if ("([{".includes(token.value)) open.push(index);
      else if (")]}".includes(token.value)) {
        const opener = open.pop();
        if (opener !== undefined) match.set(opener, index);
      }
    });
  }
  const value = (index: number) => at(index)?.value;
  const DECLARE = new Set(["const", "let", "var", "function", "class"]);
  const COMPOUND = new Set([
    "+",
    "-",
    "*",
    "/",
    "%",
    "&",
    "|",
    "^",
    "<",
    ">",
    "?",
  ]);
  const CONTROL = new Set(["if", "while", "for", "switch", "with"]);
  /** Whether the name at `index` is bound or assigned there, not just read. */
  const binds = (index: number): boolean => {
    const next = value(index + 1);
    const prev = value(index - 1);
    if (DECLARE.has(prev ?? "") || next === "=>") return true;
    if (next === "=" && value(index + 2) !== "=") return true;
    if (COMPOUND.has(next ?? "") && value(index + 2) === "=") return true;
    if (
      (next === "+" && value(index + 2) === "+") ||
      (next === "-" && value(index + 2) === "-") ||
      (prev === "+" && value(index - 2) === "+") ||
      (prev === "-" && value(index - 2) === "-")
    )
      return true;
    // Walk out through patterns: `{ a, b } = x`, `const [a] = x`, `(a) => …`.
    for (let parent = parentOf[index]; parent !== undefined;) {
      const close = match.get(parent);
      const after = close === undefined ? undefined : value(close + 1);
      if (value(parent) === "(") {
        if (after === "=>") return true;
        if (after === "{" && !CONTROL.has(value(parent - 1) ?? "")) return true;
        return false;
      }
      if (after === "=" && value((close ?? 0) + 2) !== "=") return true;
      if (DECLARE.has(value(parent - 1) ?? "")) return true;
      parent = parentOf[parent];
    }
    return false;
  };
  /** A value that ends where its declaration does, not `[...].concat(x)`. */
  const endsCleanly = (last: number): boolean => {
    const next = at(last + 1);
    return (
      next === undefined ||
      next.line > at(last)!.line ||
      next.value === ";" ||
      next.value === "," ||
      (next.value === "as" && value(last + 2) === "const")
    );
  };
  // A name can be read where it is used only when the file declares it once,
  // with `const`, as a literal list or sentence, and never rebinds it. A name
  // declared twice, a `let`, or a loop variable is a run-time value.
  const constants = new Map<string, number>();
  {
    const bindings = new Map<string, number>();
    tokens.forEach((token, index) => {
      if (token.kind === "ident" && binds(index) && value(index - 1) !== ".")
        bindings.set(token.value, (bindings.get(token.value) ?? 0) + 1);
    });
    tokens.forEach((token, index) => {
      const name = at(index + 1);
      if (
        token.kind !== "ident" ||
        token.value !== "const" ||
        name?.kind !== "ident" ||
        !isPunct(index + 2, "=") ||
        bindings.get(name.value) !== 1
      )
        return;
      const start = index + 3;
      const last =
        at(start)?.kind === "string"
          ? start
          : isPunct(start, "[")
            ? match.get(start)
            : undefined;
      if (last !== undefined && endsCleanly(last))
        constants.set(name.value, start);
    });
  }
  const MAX_SENTENCES = 10_000;
  const MAX_DEPTH = 32;
  let truncated = false;
  const reading = new Set<string>();
  /** One argument or list element at `index`; returns the index after it. */
  const argument = (index: number): number => {
    const token = at(index);
    if (!token) return index;
    const end = skipExpression(index);
    if (token.kind === "string" && end === index + 1) {
      if (token.dynamic) dynamic(token);
      else if (sentences.length >= MAX_SENTENCES) truncated = true;
      else
        sentences.push({
          text: token.value,
          source: { file, line: token.line, col: token.col },
        });
      return end;
    }
    const declared =
      token.kind === "ident" && end === index + 1
        ? constants.get(token.value)
        : undefined;
    if (
      declared !== undefined &&
      (reading.size >= MAX_DEPTH || sentences.length >= MAX_SENTENCES)
    ) {
      truncated = true;
      return end;
    }
    if (declared !== undefined && !reading.has(token.value)) {
      reading.add(token.value);
      if (isPunct(declared, "[")) list(declared);
      else argument(declared);
      reading.delete(token.value);
      return end;
    }
    dynamic(token);
    return end;
  };
  const list = (index: number): void => {
    // `[` at index: elements separated by commas, up to the matching `]`.
    let cursor = index + 1;
    while (cursor < tokens.length && !isPunct(cursor, "]")) {
      cursor = argument(cursor);
      if (isPunct(cursor, ",")) cursor++;
      else if (!isPunct(cursor, "]")) cursor++;
    }
  };
  const call = (open: number): void => {
    const first = open + 1;
    if (isPunct(first, ")")) return;
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
      // ai.group(name, [...sentences]): the name is not a step, and a
      // function body's own ai calls are found where they are written.
      const afterName = skipExpression(index + 4);
      if (!isPunct(afterName, ",")) continue;
      const second = afterName + 1;
      const value = at(second);
      if (isPunct(second, "[")) list(second);
      else if (value?.kind === "string") argument(second);
      else if (
        value?.kind === "ident" &&
        constants.has(value.value) &&
        skipExpression(second) === second + 1
      )
        argument(second);
    }
  }
  if (truncated)
    warnings.push({
      severity: "warning",
      code: "too_many_sentences",
      source: { file, line: 1, col: 1 },
      message: `This file's lists expand to more than ${MAX_SENTENCES} step sentences, or nest more than ${MAX_DEPTH} deep; the rest were not checked.`,
      fix: "Split the lists, or pass fewer copies of them to ai().",
    });
  return { sentences, warnings };
}

/**
 * Relative module specifiers a file imports, such as `./support/login.js`.
 * Validation follows them to check the sentences in shared helpers.
 */
export function scanLocalImports(source: string): readonly string[] {
  const tokens = tokenize(source);
  const found = new Set<string>();
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const after = tokens[index + 2];
    let specifier: Token | undefined;
    if (token.kind === "ident" && token.value === "from") specifier = next;
    else if (token.kind === "ident" && token.value === "import")
      specifier = next?.kind === "punct" && next.value === "(" ? after : next;
    else if (
      token.kind === "ident" &&
      token.value === "require" &&
      next?.kind === "punct" &&
      next.value === "("
    )
      specifier = after;
    if (
      specifier?.kind === "string" &&
      !specifier.dynamic &&
      /^\.\.?\//u.test(specifier.value)
    )
      found.add(specifier.value);
  });
  return [...found];
}
