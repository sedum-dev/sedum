import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { scanScriptSentences, tokenize } from "./script-sentences.js";

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
    ]);
    expect(scan.warnings[0]!.severity).toBe("warning");
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
