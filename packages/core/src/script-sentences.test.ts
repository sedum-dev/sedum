import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  callExtent,
  scanImportBindings,
  scanLocalImports,
  scanScriptSentences,
  tokenize,
} from "./script-sentences.js";

const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 500,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const file = "/project/tests/shop.test.ts";

function texts(source: string): string[] {
  return scanScriptSentences(source, file).sentences.map((item) => item.text);
}

/** A single-quoted JavaScript literal for any text. */
function singleQuoted(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")}'`;
}

describe("literal ai sentences in TypeScript tests", () => {
  it("finds single calls, lists, and group lists with their positions", () => {
    const scan = scanScriptSentences(
      [
        'test("t", async ({ page, ai }) => {',
        '  await ai("click the Login button");',
        "  await ai(['type {{user}} into the Username field', `click Next`], { user });",
        '  await ai.group("Checkout", [',
        '    "click the Cart link",',
        "  ]);",
        '  await ai.group("Pay", async () => { await ai("click Pay"); });',
        '  const total = await ai.extract("the order total");',
        "});",
      ].join("\n"),
      file,
    );
    expect(scan.sentences).toEqual([
      { text: "click the Login button", source: { file, line: 2, col: 12 } },
      {
        text: "type {{user}} into the Username field",
        source: { file, line: 3, col: 13 },
      },
      { text: "click Next", source: { file, line: 3, col: 54 } },
      { text: "click the Cart link", source: { file, line: 5, col: 5 } },
      { text: "click Pay", source: { file, line: 7, col: 48 } },
    ]);
    expect(scan.warnings).toEqual([]);
  });

  it("ignores comments, other strings, member calls, and other functions", () => {
    expect(
      texts(`
        // await ai("click in a line comment");
        /* await ai("click in a block comment") */
        const text = 'await ai("click inside a string")';
        other.ai("click on another object");
        await chai("click with another function");
        const pattern = /ai\\("click in a regex"\\)/;
        await ai("click the real button");
      `),
    ).toEqual(["click the real button"]);
  });

  it("warns about sentences built at run time", () => {
    const scan = scanScriptSentences(
      [
        "await ai(`click ${name}`);",
        'await ai("click " + name);',
        "await ai(sentence);",
        "await ai(`click the static one`);",
      ].join("\n"),
      file,
    );
    expect(scan.sentences.map((item) => item.text)).toEqual([
      "click the static one",
    ]);
    expect(scan.warnings.map((item) => [item.code, item.source.line])).toEqual([
      ["dynamic_sentence", 1],
      ["dynamic_sentence", 2],
      ["dynamic_sentence", 3],
    ]);
    expect(scan.warnings[0]!.severity).toBe("warning");
  });

  it("reads lists and sentences declared as constants in the file", () => {
    const scan = scanScriptSentences(
      [
        'const LOGIN = ["type {{user}} into the Username field", "click Login"];',
        'const CHECKOUT = "click the Checkout button";',
        "await ai(LOGIN, { user });",
        "await ai(CHECKOUT);",
        "await ai.group(title, LOGIN);",
        'await ai.group(`Pay ${n}`, ["click Pay"]);',
        "await ai.group(name, login);",
        "async function login() {}",
      ].join("\n"),
      file,
    );
    expect(scan.sentences.map((item) => [item.text, item.source.line])).toEqual(
      [
        ["type {{user}} into the Username field", 1],
        ["click Login", 1],
        ["click the Checkout button", 2],
        ["type {{user}} into the Username field", 1],
        ["click Login", 1],
        ["click Pay", 6],
      ],
    );
    // A function passed to ai.group has its own ai calls; it is not a warning.
    expect(scan.warnings).toEqual([]);
  });

  it.each([
    [
      "a loop variable shadowing a constant",
      'const step = "click the Login button";\nfor (const step of [\'type "abc into the Name field\']) await ai(step);',
    ],
    [
      "two declarations of one name",
      'test("a", async ({ ai }) => { const step = "click A"; await ai(step); });\ntest("b", async ({ ai }) => { const step = "click B"; await ai(step); });',
    ],
    [
      "a reassigned let",
      'let step = "click the Login button";\nstep = \'type "abc into the Name field\';\nawait ai(step);',
    ],
    [
      "a list built by a call",
      'const STEPS = ["click the Login button"].concat(extra);\nawait ai(STEPS);',
    ],
    [
      "a parameter with the same name",
      'const step = "click A";\nconst run = async (step: string) => ai(step);',
    ],
    [
      "a destructured name",
      'const step = "click A";\nconst { step: other, ...rest } = x;\nconst [steps] = y;\nawait ai(steps);',
    ],
  ])("does not read %s as a constant", (_name, source) => {
    const scan = scanScriptSentences(source, file);
    expect(scan.warnings.length).toBeGreaterThan(0);
    expect(scan.sentences.map((item) => item.text)).not.toContain(
      'type "abc into the Name field',
    );
  });

  it("stops expanding lists that multiply, with a warning", () => {
    const row = Array.from({ length: 200 }, () => '"click A"').join(", ");
    const source = [
      `const A = [${row}];`,
      `const B = [${Array.from({ length: 200 }, () => "A").join(", ")}];`,
      `const C = [${Array.from({ length: 200 }, () => "B").join(", ")}];`,
      "await ai(C);",
    ].join("\n");
    const scan = scanScriptSentences(source, file);
    expect(scan.sentences.length).toBeLessThanOrEqual(10_000);
    expect(scan.warnings.map((item) => item.code)).toContain(
      "too_many_sentences",
    );
  });

  it.each([
    [
      "a group list held in an imported name",
      'import { steps } from "./steps.js";\nawait ai.group("Log in", steps);',
    ],
    [
      "a group list chosen at run time",
      'await ai.group("x", ok ? ["click A"] : ["click B"]);',
    ],
    [
      "ai reached through the test context",
      'test("t", async (t) => { await t.ai("click A"); });',
    ],
    [
      "ai renamed while destructured",
      'test("t", async ({ ai: step }) => { await step("click A"); });',
    ],
    ["an optional call", 'await ai?.("click A");'],
    ["a parenthesized callee", 'await (ai)("click A");'],
    [
      "a list pushed to",
      'const steps = ["click A"];\nsteps.push("type {{x into y");\nawait ai(steps);',
    ],
    [
      "a list element replaced",
      'const steps = ["click A"];\nsteps[0] = "type {{x into y";\nawait ai(steps);',
    ],
    [
      "a list continued on the next line",
      'const steps = ["click A"]\n  .map((step) => step + "!");\nawait ai(steps);',
    ],
  ])("warns about %s", (_name, source) => {
    const scan = scanScriptSentences(source, file);
    expect(scan.warnings.length).toBeGreaterThan(0);
  });

  it.each([
    ["an alias of ai", 'const step = ai;\nawait step("type {{x into y");'],
    ["ai handed to a member call", 'await ["click A"].map(ai);'],
    ["ai called through call()", 'await ai.call(null, "click A");'],
    [
      "ai renamed in a declaration",
      'const { ai: run } = ctx;\nawait run("click A");',
    ],
    [
      "a helper parameter typed Ai under another name",
      'export async function logIn(step: Ai) { await step("type {{x into y"); }',
    ],
    [
      'a parameter typed TestContext["ai"]',
      'const logIn = async (run: TestContext["ai"]) => run("click A");',
    ],
  ])("warns about %s", (_name, source) => {
    expect(scanScriptSentences(source, file).warnings.length).toBeGreaterThan(
      0,
    );
  });

  it("stays quiet for the documented ways of passing ai around", () => {
    const scan = scanScriptSentences(
      [
        'import type { Ai } from "sedum-cli";',
        "export async function login(ai: Ai, user: string): Promise<void> {",
        '  await ai("type {{user}} into the Username field", { user });',
        "}",
        'test("t", { url: "/" }, async ({ page, ai, env }) => {',
        '  await login(ai, "ada");',
        '  await ai.group("Pay", async () => { await ai("click Pay"); });',
        '  const total = await ai.extract("the total", { parse: (text) => Number(String(text)) });',
        "  await helper({ ai });",
        "});",
      ].join("\n"),
      file,
    );
    expect(scan.warnings).toEqual([]);
    expect(scan.sentences.map((item) => item.text)).toEqual([
      "type {{user}} into the Username field",
      "click Pay",
    ]);
  });

  it("treats parameters of a function with a return type as bindings", () => {
    const scan = scanScriptSentences(
      'const steps = ["click A"];\nconst run = async (ai: Ai, steps: string[]): Promise<void> => ai(steps);',
      file,
    );
    expect(scan.warnings.length).toBeGreaterThan(0);
    expect(scan.sentences).toEqual([]);
  });

  it("resolves ai passed to a helper declared in the same file", () => {
    const named = scanScriptSentences(
      'async function login(ai: Ai, user: string) { await ai("click Login"); }\ntest("t", async ({ ai }) => { await login(ai, "ada"); });',
      file,
    );
    expect(named.warnings).toEqual([]);
    const renamed = scanScriptSentences(
      'const login = async (step) => { await step("zzz"); };\ntest("t", async ({ ai }) => { await login(ai); });',
      file,
    );
    expect(renamed.warnings.map((item) => item.code)).toEqual([
      "unchecked_call",
    ]);
  });

  it("leaves ai passed to an imported helper for validation to resolve", () => {
    const scan = scanScriptSentences(
      'import { logIn } from "./support/login.js";\ntest("t", async ({ ai }) => { await logIn(ai); });',
      file,
    );
    expect(scan.warnings).toEqual([]);
    expect(scan.helperCalls).toEqual([
      {
        callee: "logIn",
        position: 0,
        source: { file, line: 2, col: 43 },
        passes: "ai",
      },
    ]);
  });

  it.each([
    [
      "a helper declared twice in one file",
      'test("a", async ({ ai }) => {\n  async function logIn(step) { await step("zzz"); }\n  await logIn(ai);\n});\ntest("b", async ({ ai }) => {\n  async function logIn(ai) { await ai("click A"); }\n  await logIn(ai);\n});',
    ],
    [
      "ai read off the context as a value",
      'test("t", async (ctx) => { const run = ctx.ai; await run("zzz"); });',
    ],
    [
      "ai read by a computed key",
      'test("t", async (t) => { await t["ai"]("zzz"); });',
    ],
    [
      "the context handed to a member call",
      'test("t", async (ctx) => { await helpers.logIn(ctx); });',
    ],
  ])("warns about %s", (_name, source) => {
    expect(scanScriptSentences(source, file).warnings.length).toBeGreaterThan(
      0,
    );
  });

  it("leaves the context or { ai } handed to an imported helper for validation", () => {
    const scan = scanScriptSentences(
      'import { logInCtx } from "../shared/login.js";\ntest("t", async (ctx) => { await logInCtx(ctx); await logInCtx({ ai: ctx.ai }); });\ntest("u", async ({ ai }) => { await logInCtx({ ai }); });',
      file,
    );
    expect(scan.helperCalls.map((call) => [call.callee, call.passes])).toEqual([
      ["logInCtx", "context"],
      ["logInCtx", "context"],
    ]);
  });

  it("does not read a typed { ai } parameter as a rename", () => {
    expect(
      scanScriptSentences(
        'export async function login({ ai }: { ai: Ai }) { await ai("click Login"); }',
        file,
      ).warnings,
    ).toEqual([]);
  });

  it("lists import bindings with their local names", () => {
    expect(
      scanImportBindings(
        'import login, { a, b as c, type T } from "./x.js";\nimport type { Ai } from "sedum-cli";',
      ),
    ).toEqual([
      { local: "login", imported: "default", specifier: "./x.js" },
      { local: "a", imported: "a", specifier: "./x.js" },
      { local: "c", imported: "b", specifier: "./x.js" },
      { local: "T", imported: "T", specifier: "./x.js" },
      { local: "Ai", imported: "Ai", specifier: "sedum-cli" },
    ]);
  });

  it("measures a test as its whole call, not up to the next test", () => {
    const source = [
      'import { test } from "sedum-cli";',
      'test("a", async () => {',
      "  void confirm();",
      "});",
      'test("b", async () => {});',
      "for (const n of [1, 2]) test(`t${n}`, async () => {",
      "  await go(n);",
      "});",
      "async function confirm() {",
      "  throw new Error('late');",
      "}",
    ].join("\n");
    expect(callExtent(source, 2)).toEqual({ start: 2, end: 4 });
    expect(callExtent(source, 5)).toEqual({ start: 5, end: 5 });
    expect(callExtent(source, 6)).toEqual({ start: 6, end: 8 });
    // The helper below the tests (lines 9-11) is inside no test's call.
  });

  it("reads a postfix increment followed by division as division", () => {
    expect(
      texts(
        'let count = 0;\nconst half = count++ / 2; await ai("click A"); const r = /x/;',
      ),
    ).toEqual(["click A"]);
  });

  it("warns about every argument it cannot read", () => {
    const scan = scanScriptSentences(
      [
        "await ai(steps);",
        'await ai(["click Home", ...more, pick()]);',
        "await ai(cond ? 'click A' : 'click B');",
      ].join("\n"),
      file,
    );
    expect(scan.sentences.map((item) => item.text)).toEqual(["click Home"]);
    expect(scan.warnings.map((item) => item.source.line)).toEqual([1, 2, 2, 3]);
  });

  it("lists the relative modules a file imports", () => {
    expect(
      scanLocalImports(
        [
          'import { login } from "./support/login.js";',
          'import "../setup";',
          'const lazy = await import("./lazy.ts");',
          'const legacy = require("./legacy.cjs");',
          'import { test } from "sedum-cli";',
          "// import { x } from './commented.js';",
        ].join("\n"),
      ),
    ).toEqual(["./support/login.js", "../setup", "./lazy.ts", "./legacy.cjs"]);
  });

  it("decodes escapes the way JavaScript does", () => {
    expect(
      texts(
        String.raw`await ai("type \"A\u0042\x43\u{44}\" into the Name field");`,
      ),
    ).toEqual(['type "ABCD" into the Name field']);
  });

  propertyTest("any double- or single-quoted sentence is found exactly", () => {
    hegel.test((tc) => {
      const sentence = tc.draw(gs.text({ maxSize: 60 }));
      const quote = tc.draw(gs.sampledFrom(["double", "single"] as const));
      const before = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
      const literal =
        quote === "double" ? JSON.stringify(sentence) : singleQuoted(sentence);
      const source = `${"// padding\n".repeat(before)}await ai(${literal});\n`;
      const scan = scanScriptSentences(source, file);
      expect(scan.sentences).toEqual([
        { text: sentence, source: { file, line: before + 1, col: 10 } },
      ]);
    }, propertySettings);
  });

  propertyTest("commented-out calls are never found", () => {
    hegel.test((tc) => {
      const sentence = tc
        .draw(gs.text({ maxSize: 40 }))
        .replaceAll("*/", "")
        .replaceAll("\n", " ")
        .replaceAll("\r", " ")
        .replaceAll("\u2028", " ")
        .replaceAll("\u2029", " ");
      const literal = JSON.stringify(sentence);
      expect(
        texts(`// await ai(${literal});\n/* await ai(${literal}); */\n`),
      ).toEqual([]);
    }, propertySettings);
  });

  propertyTest(
    "the lexer accepts any input and keeps positions in range",
    () => {
      hegel.test((tc) => {
        const source = tc.draw(gs.text({ maxSize: 200 }));
        const lines = source.split("\n").length;
        for (const token of tokenize(source)) {
          expect(token.line).toBeGreaterThanOrEqual(1);
          expect(token.line).toBeLessThanOrEqual(lines);
          expect(token.col).toBeGreaterThanOrEqual(1);
        }
        scanScriptSentences(source, file);
      }, propertySettings);
    },
  );
});
