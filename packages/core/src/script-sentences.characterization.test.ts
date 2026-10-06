import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { describe, expect, test } from "vitest";
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

const file = "/project/tests/characterization.test.ts";

describe("script sentence public contract", () => {
  test("preserves complete scan output for mixed calls and diagnostics", () => {
    const source = [
      'const steps = ["open the cart", `buy ${item}`];',
      'const values = { account: "business" };',
      "async function checkout(ai: Ai, context: unknown) {",
      "  await ai(steps);",
      '  await ai.holds("the cart shows {{count}} items", { count: 2 });',
      '  await ai.goal("Pay with {{card}}", values);',
      "}",
      'test("checkout", async (ctx) => {',
      "  await checkout(ctx.ai, ctx);",
      "  await importedHelper(ctx);",
      "});",
    ].join("\n");

    const scan = scanScriptSentences(source, file);

    expect(scan).toEqual({
      sentences: [
        {
          text: "open the cart",
          source: { file, line: 1, col: 16 },
        },
        {
          text: "the cart shows {{count}} items",
          source: { file, line: 5, col: 18 },
          check: true,
        },
      ],
      warnings: [
        {
          severity: "warning",
          code: "dynamic_sentence",
          source: { file, line: 1, col: 33 },
          message:
            "This step sentence is not a literal, so it cannot be checked before a run, and a sentence built from values is classified again for every value.",
          fix: 'Write a literal sentence with {{name}} and pass the value separately: ai("type {{email}} into the Email field", { email }).',
        },
        {
          severity: "error",
          code: "missing_value",
          source: { file, line: 6, col: 17 },
          message: "{{card}} has no value.",
          fix: "Pass its value as the second argument to ai.goal.",
        },
        {
          severity: "warning",
          code: "unchecked_call",
          source: { file, line: 9, col: 22 },
          message:
            "This reaches ai through another object, so the steps it runs are not checked before a run.",
          fix: "Call the test's `ai` directly, as ai(...) or ai.group(...), so its sentences can be checked before a run.",
        },
      ],
      functions: new Map([["checkout", ["ai", "context"]]]),
      helperCalls: [
        {
          callee: "importedHelper",
          position: 0,
          source: { file, line: 10, col: 24 },
          passes: "context",
        },
      ],
    });
  });

  test("finds generated local imports in first-seen order", () => {
    hegel.test((tc) => {
      const specifiers = tc.draw(
        gs.arrays(
          gs.sampledFrom([
            "./alpha.js",
            "../beta.ts",
            "./nested/gamma.cjs",
            "external-package",
          ]),
          { maxSize: 20 },
        ),
      );
      const forms = tc.draw(
        gs.arrays(gs.sampledFrom(["from", "dynamic", "require"] as const), {
          minSize: specifiers.length,
          maxSize: specifiers.length,
        }),
      );
      const source = specifiers
        .map((specifier, index) => {
          const literal = JSON.stringify(specifier);
          if (forms[index] === "dynamic") return `void import(${literal});`;
          if (forms[index] === "require") return `require(${literal});`;
          return `import { helper } from ${literal};`;
        })
        .join("\n");
      const expected = [
        ...new Set(specifiers.filter((specifier) => specifier.startsWith("."))),
      ];

      expect(scanLocalImports(source)).toEqual(expected);
    }, propertySettings);
  });

  test("measures generated multiline calls from their opening line", () => {
    hegel.test((tc) => {
      const padding = tc.draw(gs.integers({ minValue: 0, maxValue: 8 }));
      const bodyLines = tc.draw(gs.integers({ minValue: 0, maxValue: 20 }));
      const start = padding + 1;
      const source = [
        ...Array.from({ length: padding }, () => "// padding"),
        'test("generated", async () => {',
        ...Array.from(
          { length: bodyLines },
          (_, index) => `  await helper(${index}, nested(${index}));`,
        ),
        "});",
      ].join("\n");

      expect(callExtent(source, start)).toEqual({
        start,
        end: start + bodyLines + 1,
      });
    }, propertySettings);
  });

  test("keeps independently calculated token source positions", () => {
    hegel.test((tc) => {
      const lines = tc.draw(
        gs.arrays(gs.sampledFrom(["alpha", "beta_2", "$value"]), {
          minSize: 1,
          maxSize: 30,
        }),
      );
      const indents = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 12 }), {
          minSize: lines.length,
          maxSize: lines.length,
        }),
      );
      const source = lines
        .map(
          (identifier, index) => `${" ".repeat(indents[index]!)}${identifier};`,
        )
        .join("\n");

      const identifiers = tokenize(source).filter(
        (token) => token.kind === "ident",
      );
      expect(identifiers).toEqual(
        lines.map((value, index) => ({
          kind: "ident",
          value,
          line: index + 1,
          col: indents[index]! + 1,
        })),
      );
    }, propertySettings);
  });

  test("preserves named and default import bindings", () => {
    expect(
      scanImportBindings(
        'import primary, { named, original as local, type Shape } from "./helpers.js";',
      ),
    ).toEqual([
      { local: "primary", imported: "default", specifier: "./helpers.js" },
      { local: "named", imported: "named", specifier: "./helpers.js" },
      { local: "local", imported: "original", specifier: "./helpers.js" },
      { local: "Shape", imported: "Shape", specifier: "./helpers.js" },
    ]);
  });
});
