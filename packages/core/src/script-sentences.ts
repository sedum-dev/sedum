import type { FlowDiagnostic, FlowSource } from "./flow-types.js";

/** A literal step sentence written in a `*.test.ts` file. */
export interface ScriptSentence {
  readonly text: string;
  readonly source: FlowSource;
  /** The sentence is a claim passed to `ai.holds`, not a general step. */
  readonly check?: true;
}

export interface ScriptSentenceScan {
  readonly sentences: readonly ScriptSentence[];
  /** Sentences built at run time; they cannot be checked before a run. */
  readonly warnings: readonly FlowDiagnostic[];
  /** Parameter names of the functions this file declares, by position. */
  readonly functions: ReadonlyMap<string, readonly string[]>;
  /**
   * `f(ai)` calls to a function this file does not declare. Validation
   * resolves them through imports: the parameter must be named `ai`.
   */
  readonly helperCalls: readonly HelperCall[];
}

export interface HelperCall {
  readonly callee: string;
  readonly position: number;
  readonly source: FlowSource;
  /**
   * `ai`: the test's ai itself, so the parameter must be named `ai`.
   * `context`: the test's context or `{ ai }`, so the helper must be one
   * validation reads.
   */
  readonly passes: "ai" | "context";
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
      const before = tokens.at(-2);
      // `count++ / 2` divides: a postfix ++ or -- ends a value.
      const postfix =
        (previous?.value === "+" || previous?.value === "-") &&
        before?.value === previous.value;
      if (!postfix && (!previous || REGEX_AFTER.has(previous.value))) {
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
 * Find the literal sentences passed to `ai(...)`, `ai([...])`,
 * `ai.group(name, [...])`, and `ai.holds(...)`. A sentence built with `${}` or
 * `+` is reported as a warning: it defeats the classification cache and cannot
 * be checked before a run. `ai.extract` takes a description, not a step, so it
 * is skipped.
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
  const MUTATORS = new Set([
    "push",
    "unshift",
    "splice",
    "pop",
    "shift",
    "sort",
    "reverse",
    "fill",
    "copyWithin",
  ]);
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
    // A list changed in place is not the literal it was declared as.
    if (next === "." && MUTATORS.has(value(index + 2) ?? "")) return true;
    if (next === "[") {
      const close = match.get(index + 1);
      if (
        close !== undefined &&
        value(close + 1) === "=" &&
        value(close + 2) !== "="
      )
        return true;
    }
    // Walk out through patterns: `{ a, b } = x`, `const [a] = x`, `(a) => …`.
    for (let parent = parentOf[index]; parent !== undefined;) {
      const close = match.get(parent);
      const after = close === undefined ? undefined : value(close + 1);
      if (value(parent) === "(") {
        if (after === "=>") return true;
        if (after === "{" && !CONTROL.has(value(parent - 1) ?? "")) return true;
        // `(steps: string[]): Promise<void> => …` and `function f(): T {`.
        if (after === ":" && close !== undefined) {
          for (let cursor = close + 2; cursor < close + 40; cursor++) {
            const token = value(cursor);
            if (token === "=>" || token === "{") return true;
            if (token === undefined || token === ";" || token === ")") break;
            const skip = match.get(cursor);
            if (skip !== undefined && token !== "{") cursor = skip;
          }
        }
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
      (next.line > at(last)!.line && !".[(?".includes(next.value)) ||
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
  /** An inline `async () => …`, `function () {…}`, or `(x) => …` body. */
  const inlineFunction = (index: number): boolean => {
    let cursor = index;
    if (value(cursor) === "async") cursor++;
    if (value(cursor) === "function") return true;
    if (at(cursor)?.kind === "ident" && value(cursor + 1) === "=>") return true;
    const close = isPunct(cursor, "(") ? match.get(cursor) : undefined;
    return close !== undefined && value(close + 1) === "=>";
  };
  // Functions declared in this file: `function login(`, `const login = (…) =>`.
  /** Parameter names in the list opened at `paren`, by position. */
  const parameters = (paren: number): string[] => {
    const close = match.get(paren);
    if (close === undefined) return [];
    const names: string[] = [];
    let expectName = true;
    for (let cursor = paren + 1; cursor < close; cursor++) {
      if (expectName) {
        const token = at(cursor);
        names.push(token?.kind === "ident" ? token.value : "");
        expectName = false;
      }
      const skip = match.get(cursor);
      if (skip !== undefined) cursor = skip;
      else if (isPunct(cursor, ",")) expectName = true;
    }
    return names;
  };
  // A name bound more than once (nested helpers, a parameter, a shadowing
  // const) cannot be resolved to one function without scopes.
  const bindingCount = new Map<string, number>();
  tokens.forEach((token, index) => {
    if (token.kind === "ident" && value(index - 1) !== "." && binds(index))
      bindingCount.set(token.value, (bindingCount.get(token.value) ?? 0) + 1);
  });
  const functions = new Map<string, string[]>();
  const ambiguous = new Set<string>();
  tokens.forEach((token, index) => {
    const name = at(index + 1);
    if (token.kind !== "ident" || name?.kind !== "ident") return;
    if ((bindingCount.get(name.value) ?? 0) > 1) {
      if (
        (token.value === "function" && isPunct(index + 2, "(")) ||
        (["const", "let", "var"].includes(token.value) &&
          isPunct(index + 2, "=") &&
          inlineFunction(index + 3))
      )
        ambiguous.add(name.value);
      return;
    }
    if (token.value === "function" && isPunct(index + 2, "("))
      functions.set(name.value, parameters(index + 2));
    else if (
      ["const", "let", "var"].includes(token.value) &&
      isPunct(index + 2, "=") &&
      inlineFunction(index + 3)
    ) {
      let start = index + 3;
      if (value(start) === "async") start++;
      if (value(start) === "function") start++;
      if (isPunct(start, "(")) functions.set(name.value, parameters(start));
      else if (at(start)?.kind === "ident" && isPunct(start + 1, "("))
        functions.set(name.value, parameters(start + 1));
      else if (at(start)?.kind === "ident")
        functions.set(name.value, [value(start)!]);
    }
  });
  const helperCalls: HelperCall[] = [];
  /**
   * Why `ai` at `index` is used as a value that runs steps under another
   * name, or undefined. Calling it, naming a parameter `ai`, shorthand
   * `{ ai }`, and passing it straight to a named helper are fine: the helper's
   * own `ai` calls are checked where it is written.
   */
  const aliasUse = (index: number): string | undefined => {
    const next = value(index + 1);
    const prev = value(index - 1);
    if (next === "(" || next === "?") return undefined;
    if (next === ".") {
      const member = value(index + 2);
      return ["call", "apply", "bind"].includes(member ?? "")
        ? "This ai call is written indirectly, so its sentences are not checked before a run."
        : undefined;
    }
    if (next === ":") {
      // `const { ai: run } = ctx` renames it; `{ ai: x }` in a literal is a key.
      const brace = parentOf[index];
      return brace !== undefined &&
        DECLARE.has(value(brace - 1) ?? "") &&
        at(index + 2)?.kind === "ident"
        ? "`ai` is renamed here, so the steps called through the new name are not checked before a run."
        : undefined;
    }
    if ((prev === "{" || prev === ",") && (next === "}" || next === ",")) {
      const brace = parentOf[index];
      if (brace !== undefined && value(brace) === "{")
        return handedOver(brace, "`{ ai }`");
    }
    const parent = parentOf[index];
    if (parent !== undefined && value(parent) === "(") {
      const close = match.get(parent);
      const after = close === undefined ? undefined : value(close + 1);
      // A parameter named ai.
      if (after === "=>" || after === "{" || after === ":") return undefined;
      const callee = at(parent - 1);
      if (
        callee?.kind === "ident" &&
        value(parent - 2) !== "." &&
        !CONTROL.has(callee.value) &&
        (next === "," || next === ")")
      ) {
        // `login(ai)`: fine when login's parameter there is named `ai`, so its
        // own ai calls are the ones validation reads.
        let position = 0;
        for (let cursor = parent + 1; cursor < index; cursor++) {
          const skip = match.get(cursor);
          if (skip !== undefined) cursor = skip;
          else if (isPunct(cursor, ",")) position++;
        }
        if (ambiguous.has(callee.value))
          return `\`${callee.value}\` is declared more than once in this file, so validation cannot tell which one receives the test's ai.`;
        const local = functions.get(callee.value);
        if (local)
          return local[position] === "ai"
            ? undefined
            : `\`${callee.value}\` receives the test's ai under another name, so the steps it runs are not checked before a run.`;
        const token = at(index)!;
        helperCalls.push({
          callee: callee.value,
          position,
          source: { file, line: token.line, col: token.col },
          passes: "ai",
        });
        return undefined;
      }
    }
    return "`ai` is passed on as a value here, so the steps it runs are not checked before a run.";
  };
  /**
   * The test's context, or an object holding `ai`, at `index` inside some
   * parentheses: fine as a parameter pattern or a destructuring, or when it
   * is handed to a helper validation reads (declared once here, or imported
   * from a local module it follows). Otherwise, why it is not checked.
   */
  const handedOver = (index: number, what: string): string | undefined => {
    const parent = parentOf[index];
    if (parent === undefined || value(parent) !== "(") return undefined;
    const close = match.get(parent);
    const after = close === undefined ? undefined : value(close + 1);
    if (after === "=>" || after === "{" || after === ":") return undefined;
    const callee = at(parent - 1);
    if (callee?.kind !== "ident" || CONTROL.has(callee.value)) return undefined;
    if (value(parent - 2) === ".")
      return `${what} is handed to \`${callee.value}\` through another object, so the steps it runs are not checked before a run.`;
    if (ambiguous.has(callee.value))
      return `\`${callee.value}\` is declared more than once in this file, so validation cannot tell which one receives ${what}.`;
    if (functions.has(callee.value)) return undefined;
    let position = 0;
    for (let cursor = parent + 1; cursor < index; cursor++) {
      const skip = match.get(cursor);
      if (skip !== undefined) cursor = skip;
      else if (isPunct(cursor, ",")) position++;
    }
    const token = at(index)!;
    helperCalls.push({
      callee: callee.value,
      position,
      source: { file, line: token.line, col: token.col },
      passes: "context",
    });
    return undefined;
  };
  const unchecked = (token: Token, message: string) =>
    warnings.push({
      severity: "warning",
      code: "unchecked_call",
      source: { file, line: token.line, col: token.col },
      message,
      fix: "Call the test's `ai` directly, as ai(...) or ai.group(...), so its sentences can be checked before a run.",
    });
  /** Whether `ai` at `index` is renamed while being destructured from a parameter. */
  const renamedParameter = (index: number): boolean => {
    if (!isPunct(index + 1, ":") || at(index + 2)?.kind !== "ident")
      return false;
    const brace = parentOf[index];
    if (brace === undefined || value(brace) !== "{") return false;
    // `({ ai }: { ai: Ai })`: the second brace is a type, not a rename.
    if (value(brace - 1) === ":") return false;
    const paren = parentOf[brace];
    if (paren === undefined || value(paren) !== "(") return false;
    const close = match.get(paren);
    return (
      close !== undefined &&
      (value(close + 1) === "=>" || value(close + 1) === "{")
    );
  };
  // `t["ai"]`: ai reached through an object by a computed key.
  tokens.forEach((token, index) => {
    if (
      token.kind === "string" &&
      !token.dynamic &&
      token.value === "ai" &&
      isPunct(index - 1, "[") &&
      isPunct(index + 1, "]") &&
      value(index - 2) !== "TestContext"
    )
      unchecked(
        token,
        "This reaches ai through another object, so the steps it runs are not checked before a run.",
      );
  });
  // A test's context handed to a helper: its `ai` runs where validation must
  // be able to follow.
  const contexts = new Set<string>();
  tokens.forEach((token, index) => {
    if (
      token.kind !== "ident" ||
      token.value !== "test" ||
      !isPunct(index + 1, "(")
    )
      return;
    const close = match.get(index + 1);
    if (close === undefined) return;
    // Only a function passed directly as an argument of test() is the
    // test's body; functions nested inside it have their own parameters.
    for (let cursor = index + 2; cursor < close; cursor++) {
      if (parentOf[cursor] !== index + 1) continue;
      let start = cursor;
      if (value(start) === "async") start++;
      if (value(start) === "function") start++;
      const inner = isPunct(start, "(") ? match.get(start) : undefined;
      if (
        inner !== undefined &&
        (value(inner + 1) === "=>" || value(start - 1) === "function")
      ) {
        const first = parameters(start)[0];
        if (first) contexts.add(first);
      }
    }
  });
  tokens.forEach((token, index) => {
    if (
      token.kind !== "ident" ||
      !contexts.has(token.value) ||
      value(index - 1) === "." ||
      !["(", ","].includes(value(index - 1) ?? "") ||
      ![")", ","].includes(value(index + 1) ?? "")
    )
      return;
    const reason = handedOver(index, `The test's context \`${token.value}\``);
    if (reason) unchecked(token, reason);
  });
  // `step: Ai` or `step: TestContext["ai"]`: steps run under another name.
  tokens.forEach((token, index) => {
    if (
      token.kind === "ident" &&
      token.value !== "ai" &&
      value(index - 1) !== "." &&
      isPunct(index + 1, ":") &&
      (value(index + 2) === "Ai" ||
        (value(index + 2) === "TestContext" &&
          isPunct(index + 3, "[") &&
          at(index + 4)?.kind === "string" &&
          value(index + 4) === "ai"))
    )
      unchecked(
        token,
        `\`${token.value}\` holds the test's ai, so the steps called through it are not checked before a run.`,
      );
  });
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind !== "ident" || token.value !== "ai") continue;
    if (isPunct(index - 1, ".")) {
      // `t.ai("...")`, `t.ai.group(...)`, or `const run = t.ai`: `ai`
      // reached through an object runs steps validation cannot see.
      unchecked(
        token,
        "This reaches ai through another object, so the steps it runs are not checked before a run.",
      );
      continue;
    }
    if (renamedParameter(index)) {
      unchecked(
        token,
        "`ai` is renamed here, so the steps called through the new name are not checked before a run.",
      );
      continue;
    }
    if (
      (isPunct(index + 1, "?") &&
        isPunct(index + 2, ".") &&
        isPunct(index + 3, "(")) ||
      (isPunct(index - 1, "(") &&
        isPunct(index + 1, ")") &&
        isPunct(index + 2, "("))
    ) {
      unchecked(
        token,
        "This ai call is written indirectly, so its sentences are not checked before a run.",
      );
      continue;
    }
    const alias = aliasUse(index);
    if (alias) {
      unchecked(token, alias);
      continue;
    }
    if (isPunct(index + 1, "(")) {
      call(index + 1);
      continue;
    }
    const member = isPunct(index + 1, ".")
      ? index + 2
      : isPunct(index + 1, "?") && isPunct(index + 2, ".")
        ? index + 3
        : undefined;
    let holdsOpen: number | undefined;
    if (
      member !== undefined &&
      at(member)?.kind === "ident" &&
      at(member)!.value === "holds"
    ) {
      const after = member + 1;
      if (isPunct(after, "(")) holdsOpen = after;
      else if (
        isPunct(after, "?") &&
        isPunct(after + 1, ".") &&
        isPunct(after + 2, "(")
      )
        holdsOpen = after + 2;
    }
    if (holdsOpen !== undefined) {
      const first = holdsOpen + 1;
      const firstToken = at(first);
      const declared =
        firstToken?.kind === "ident"
          ? constants.get(firstToken.value)
          : undefined;
      if (
        isPunct(first, ")") ||
        isPunct(first, "[") ||
        (declared !== undefined && isPunct(declared, "["))
      ) {
        unchecked(
          token,
          "ai.holds requires one string claim, so this value is not checked before a run.",
        );
        continue;
      }
      const afterClaim = skipExpression(first);
      if (isPunct(afterClaim, ",")) {
        const valuesIndex = afterClaim + 1;
        const values = at(valuesIndex);
        const afterValues = skipExpression(valuesIndex);
        const validValues =
          isPunct(valuesIndex, "{") ||
          (values?.kind === "ident" && values.value !== "null");
        if (!validValues || isPunct(afterValues, ",")) {
          unchecked(
            token,
            "This ai.holds call has invalid or extra arguments, so its claim is not checked before a run.",
          );
          continue;
        }
      }
      const before = sentences.length;
      call(holdsOpen);
      for (let found = before; found < sentences.length; found++)
        sentences[found] = { ...sentences[found]!, check: true };
      continue;
    }
    if (
      member !== undefined &&
      at(member)?.kind === "ident" &&
      at(member)!.value === "holds"
    ) {
      unchecked(
        token,
        "This ai.holds call is written indirectly, so its claim is not checked before a run.",
      );
      continue;
    }
    if (
      isPunct(index + 1, ".") &&
      at(index + 2)?.kind === "ident" &&
      at(index + 2)!.value === "group" &&
      isPunct(index + 3, "(")
    ) {
      // ai.group(name, steps): the name is not a step. A function body's own
      // ai calls are found where they are written; any other second argument
      // is a list validation cannot see.
      const afterName = skipExpression(index + 4);
      if (!isPunct(afterName, ",")) continue;
      const second = afterName + 1;
      const first = at(second);
      if (isPunct(second, "[")) list(second);
      else if (
        first?.kind === "string" ||
        (first?.kind === "ident" && constants.has(first.value))
      )
        argument(second);
      else if (
        !inlineFunction(second) &&
        !(
          first?.kind === "ident" &&
          functions.has(first.value) &&
          skipExpression(second) === second + 1
        )
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
  return { sentences, warnings, functions, helperCalls };
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

export interface ImportBinding {
  readonly local: string;
  readonly imported: string;
  readonly specifier: string;
}

/** Named and default imports: `import login, { a, b as c } from "./x.js"`. */
export function scanImportBindings(source: string): readonly ImportBinding[] {
  const tokens = tokenize(source);
  const bindings: ImportBinding[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "ident" || token.value !== "import") return;
    const names: { local: string; imported: string }[] = [];
    let cursor = index + 1;
    if (tokens[cursor]?.kind === "ident" && tokens[cursor]!.value === "type")
      cursor++;
    if (tokens[cursor]?.kind === "ident" && tokens[cursor]!.value !== "from") {
      names.push({ local: tokens[cursor]!.value, imported: "default" });
      cursor++;
      if (tokens[cursor]?.value === ",") cursor++;
    }
    if (tokens[cursor]?.value === "{") {
      cursor++;
      while (cursor < tokens.length && tokens[cursor]!.value !== "}") {
        const name = tokens[cursor];
        if (name?.kind === "ident" && name.value !== "type") {
          if (
            tokens[cursor + 1]?.value === "as" &&
            tokens[cursor + 2]?.kind === "ident"
          ) {
            names.push({
              local: tokens[cursor + 2]!.value,
              imported: name.value,
            });
            cursor += 3;
            continue;
          }
          names.push({ local: name.value, imported: name.value });
        }
        cursor++;
      }
      cursor++;
    }
    const from = tokens[cursor];
    const specifier = tokens[cursor + 1];
    if (
      from?.kind === "ident" &&
      from.value === "from" &&
      specifier?.kind === "string" &&
      !specifier.dynamic
    )
      for (const name of names)
        bindings.push({ ...name, specifier: specifier.value });
  });
  return bindings;
}

/**
 * The lines of the call expression that starts on `line`, such as a whole
 * `test("…", async () => { … })`, so a helper declared elsewhere in the file
 * is not mistaken for part of a test. The outermost call on the line wins.
 */
export function callExtent(
  source: string,
  line: number,
): { readonly start: number; readonly end: number } | undefined {
  const tokens = tokenize(source);
  const open: number[] = [];
  let best: number | undefined;
  tokens.forEach((token, index) => {
    if (token.kind !== "punct") return;
    if ("([{".includes(token.value)) open.push(index);
    else if (")]}".includes(token.value)) {
      const opener = open.pop();
      if (
        opener === undefined ||
        tokens[opener]!.value !== "(" ||
        tokens[opener]!.line !== line ||
        tokens[opener - 1]?.kind !== "ident"
      )
        return;
      if (best === undefined || token.line > tokens[best]!.line) best = index;
    }
  });
  return best === undefined
    ? undefined
    : { start: line, end: tokens[best]!.line };
}
