import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { tokenizeStep } from "./flow-values.js";
import type { SentenceStep } from "./flow-types.js";
import { secret } from "./script-registry.js";
import {
  inlineValues,
  ScriptUsageError,
  valueEntries,
} from "./script-runner.js";

const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 500,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const source = { file: "/p/a.test.ts", line: 1, col: 1 };

function step(text: string): SentenceStep {
  return {
    kind: "sentence",
    phase: "steps",
    text,
    tokens: tokenizeStep(text).tokens,
    source,
  };
}

/** Text that cannot change a sentence's quotes or placeholders. */
const plainValue = gs
  .text({ minSize: 1, maxSize: 20 })
  .map((value) => value.replace(/["\n{}]/gu, "x"));

describe("ai values", () => {
  it("turns plain values into model-visible entries and secrets into opaque ones", () => {
    const entries = valueEntries({
      name: "Ada",
      count: 2,
      member: true,
      password: secret("pw"),
    });
    expect(entries.name).toMatchObject({
      sensitive: false,
      modelVisible: true,
    });
    expect(entries.name!.value.reveal()).toBe("Ada");
    expect(entries.count!.value.reveal()).toBe("2");
    expect(entries.member!.value.reveal()).toBe("true");
    expect(entries.password).toMatchObject({
      sensitive: true,
      modelVisible: false,
    });
    expect(
      entries.password!.opaqueValues?.map((value) => value.reveal()),
    ).toEqual(["pw"]);
    expect(JSON.stringify(entries)).not.toContain("pw");
    expect(valueEntries(undefined)).toEqual({});
  });

  it.each([
    ["an array", ["a"]],
    ["a bad key", { "not-valid": "x" }],
    ["an object value", { user: {} }],
    ["NaN", { count: Number.NaN }],
    ["undefined", { user: undefined }],
  ])("rejects %s", (_name, values) => {
    expect(() => valueEntries(values as never)).toThrow(ScriptUsageError);
  });

  it("inlines plain values into click and verify sentences", () => {
    const values = valueEntries({ product: "Sauce Labs Onesie", count: 2 });
    expect(
      inlineValues(step("click Add to cart for {{product}}"), "click", values),
    ).toBe("click Add to cart for Sauce Labs Onesie");
    expect(
      inlineValues(
        step("verify the cart shows {{count}} items"),
        "verify",
        values,
      ),
    ).toBe("verify the cart shows 2 items");
  });

  it("keeps the typed value, secrets, and unsafe values as placeholders", () => {
    const values = valueEntries({
      first: "Ada",
      field: "First name",
      password: secret("pw"),
      quoted: 'say "hi"',
    });
    expect(
      inlineValues(
        step("type {{first}} into the {{field}} field"),
        "type",
        values,
      ),
    ).toBe("type {{first}} into the First name field");
    expect(
      inlineValues(
        step("type {{password}} into the Password field"),
        "type",
        values,
      ),
    ).toBe("type {{password}} into the Password field");
    expect(
      inlineValues(
        step("verify the page shows {{password}}"),
        "verify",
        values,
      ),
    ).toBe("verify the page shows {{password}}");
    expect(inlineValues(step("click {{quoted}}"), "click", values)).toBe(
      "click {{quoted}}",
    );
  });

  propertyTest("inlining replaces exactly the plain placeholders", () => {
    hegel.test((tc) => {
      const shown = tc.draw(plainValue);
      const hidden = tc.draw(gs.text({ minSize: 1, maxSize: 20 }));
      const op = tc.draw(gs.sampledFrom(["click", "verify"] as const));
      const text = `${op} {{shown}} next to {{hidden}} and {{shown}}`;
      const result = inlineValues(
        step(text),
        op,
        valueEntries({ shown, hidden: secret(hidden) }),
      );
      expect(result).toBe(`${op} ${shown} next to {{hidden}} and ${shown}`);
      const left = tokenizeStep(result).tokens.filter(
        (token) => token.kind === "placeholder",
      );
      expect(left.map((token) => token.key)).toEqual(["hidden"]);
    }, propertySettings);
  });

  propertyTest("a type step's value is never inlined", () => {
    hegel.test((tc) => {
      const value = tc.draw(plainValue);
      const field = tc.draw(plainValue);
      const result = inlineValues(
        step("type {{value}} into the {{field}} field"),
        "type",
        valueEntries({ value, field }),
      );
      expect(result).toBe(`type {{value}} into the ${field} field`);
    }, propertySettings);
  });
});
