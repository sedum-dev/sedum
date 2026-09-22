import { describe, expect, it } from "vitest";
import { parseFlow } from "./flow-loader.js";
import { isFullyValidated } from "./flow-types.js";
import {
  DataResolutionError,
  parseDataTemplate,
  resolveData,
  resolveTypeOperand,
  tokenizeStep,
  validateTypeOperand,
} from "./flow-values.js";

const options = { repoRoot: "/project" };

describe("runtime flow data", () => {
  it("resolves environment values only when selected to run, with safe display", () => {
    const source = `data:
  user: Ada
  password: $PASSWORD
  url: https://\${HOST}/app
  money: $$9.99
  count: 2
  enabled: true
steps:
  - type {{password}} in the password field
`;
    const parsed = parseFlow(source, "/project/test.test.yaml", options);
    expect(parsed.value).toBeDefined(); // No environment lookup during load.
    const resolved = resolveData(parsed.value!.data, {
      PASSWORD: "top-secret",
      HOST: "example.com",
    });
    expect(resolved.password!.sensitive).toBe(true);
    expect(resolved.password!.value.reveal()).toBe("top-secret");
    expect(resolved.url!.value.reveal()).toBe("https://example.com/app");
    expect(resolved.money!.value.reveal()).toBe("$9.99");
    expect(resolved.count!.value.reveal()).toBe("2");
    expect(resolved.enabled!.value.reveal()).toBe("true");
    expect(resolved.count!.sensitive).toBe(false);
    expect(JSON.stringify(resolved)).not.toContain("top-secret");
    expect(JSON.stringify(resolved)).not.toContain("example.com");
    expect(String(resolved.password!.value)).toBe("{{password}}");
  });

  it("fails one selected test for a missing variable without exposing values", () => {
    const flow = parseFlow(
      "data:\n  password: ${SECRET}\nsteps: [click x]",
      "/project/one.test.yaml",
      options,
    ).value!;
    expect(() => resolveData(flow.data, {})).toThrow(DataResolutionError);
    expect(() => resolveData(flow.data, {})).toThrow(
      "/project/one.test.yaml:2:13: data.password needs $SECRET",
    );
    const unrelated = parseFlow(
      "steps: [click y]",
      "/project/two.test.yaml",
      options,
    );
    expect(unrelated.value).toBeDefined();
  });

  it("requires environment values to be own string properties", () => {
    const flow = parseFlow(
      "data: { inherited: $constructor, method: $toString }\nsteps: [click x]",
      "/project/inherited.test.yaml",
      options,
    ).value!;
    expect(() => resolveData(flow.data, {})).toThrow(DataResolutionError);
    expect(() => resolveData(flow.data, { constructor: "set" })).toThrow(
      "data.method needs $toString",
    );
    expect(() =>
      resolveData(flow.data, { constructor: 42 } as unknown as Record<
        string,
        string
      >),
    ).toThrow(DataResolutionError);
  });

  it("accepts only the deliberate environment template grammar", () => {
    expect(parseDataTemplate("$VAR and ${OTHER} then $$9.99")).toEqual({
      parts: [
        { variable: "VAR" },
        { literal: " and " },
        { variable: "OTHER" },
        { literal: " then $9.99" },
      ],
    });
    for (const value of ["$9.99", "${BAD-NAME}", "${UNFINISHED", "trailing$"]) {
      expect(
        parseFlow(
          `data: { value: "${value}" }\nsteps: [click x]`,
          "/project/bad.test.yaml",
          options,
        ).diagnostics.map((item) => item.code),
      ).toContain("invalid_env_template");
    }
  });

  it("warns when YAML numeric coercion changes the text to type", () => {
    const parsed = parseFlow(
      'data: { amount: 1e3, postcode: "094016" }\nsteps: [click x]',
      "/project/numbers.test.yaml",
      options,
    );
    expect(parsed.diagnostics.map((item) => item.code)).toContain(
      "scalar_coercion",
    );
    expect(parsed.value?.data.postcode?.value).toBe("094016");
  });
});

describe("step values", () => {
  it("keeps placeholder text intact and rejects missing names", () => {
    const parsed = parseFlow(
      "data: { password: $PASS }\nsteps:\n  - type {{password}} in the field\n",
      "/project/test.test.yaml",
      options,
    );
    expect(parsed.value?.steps[0]).toMatchObject({
      text: "type {{password}} in the field",
    });
    const unknown = parseFlow(
      "steps:\n  - type {{secret}} in the field\n",
      "/project/unknown.test.yaml",
      options,
    );
    expect(unknown.diagnostics.map((item) => item.code)).toContain(
      "unknown_placeholder",
    );
  });

  it("treats one quoted composite as one type value, including its inner placeholder", () => {
    const parsed = parseFlow(
      `data: { user: Ada }
steps:
  - type "{{user}}@example.com" in "email field"
`,
      "/project/composite.test.yaml",
      options,
    );
    expect(parsed.diagnostics).toEqual([]);
    const step = parsed.value!.steps[0]!;
    expect(step.kind).toBe("sentence");
    if (step.kind !== "sentence") return;
    const result = validateTypeOperand(step);
    expect("operand" in result).toBe(true);
    if (!("operand" in result)) return;
    expect(result.operand.kind).toBe("quoted");
    const value = resolveTypeOperand(
      result.operand,
      resolveData(parsed.value!.data, {}),
    );
    expect(value.reveal()).toBe("Ada@example.com");
    expect(JSON.stringify(value)).not.toContain("Ada@example.com");
  });

  it("rejects the PoC first-match ambiguity before execution", () => {
    const parsed = parseFlow(
      `data: { first: Ada, last: Lovelace }
steps:
  - type {{first}} then {{last}}
`,
      "/project/ambiguous.test.yaml",
      options,
    );
    const step = parsed.value!.steps[0]!;
    if (step.kind !== "sentence") throw new Error("Expected sentence");
    const result = validateTypeOperand(step);
    expect(result).toMatchObject({
      diagnostic: { code: "ambiguous_type_value", source: { line: 3 } },
    });
    const diagnostics = "diagnostic" in result ? [result.diagnostic] : [];
    expect(
      isFullyValidated(
        { format: "passed", steps: "checked", modules: "not_needed" },
        diagnostics,
      ),
    ).toBe(false);
  });

  it("reports a missing type value with a useful fix", () => {
    const parsed = parseFlow(
      "steps: [type in the field]",
      "/project/missing.test.yaml",
      options,
    );
    const step = parsed.value!.steps[0]!;
    if (step.kind !== "sentence") throw new Error("Expected sentence");
    expect(validateTypeOperand(step)).toMatchObject({
      diagnostic: {
        code: "missing_type_value",
        fix: expect.stringContaining("double quotes"),
      },
    });
  });

  it("does not treat a quoted or placeholder field target as the type value", () => {
    for (const sentence of [
      'type in the "username" field',
      "type in the {{user}} field",
      'type into the "username" field',
    ]) {
      const parsed = parseFlow(
        `data: { user: Ada }\nsteps:\n  - ${sentence}\n`,
        "/project/target.test.yaml",
        options,
      );
      const step = parsed.value!.steps[0]!;
      if (step.kind !== "sentence") throw new Error("Expected sentence");
      expect(validateTypeOperand(step)).toMatchObject({
        diagnostic: { code: "missing_type_value" },
      });
    }
  });

  it("identifies malformed placeholders, unexpected closers, and unclosed quotes", () => {
    const tokens = tokenizeStep('type {{bad-name}} }} "open');
    expect(tokens.problems.map((item) => item.code)).toEqual([
      "invalid_placeholder",
      "invalid_placeholder",
      "unclosed_quote",
    ]);
  });
});
