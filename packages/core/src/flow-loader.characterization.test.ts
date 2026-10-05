import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseFlow, parseModule, validateFlows } from "./flow-loader.js";

const options = {
  repoRoot: "/project",
  baseUrl: "https://example.test/app/",
};
const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 500,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const validFlowSource = `sedum: 1
id: checkout
description: Checkout smoke test
url: /checkout
data:
  user: Ada
  count: 01
  enabled: true
  empty: null
before:
  - remember the cart total as {{total}}
steps:
  - use: ./checkout.module.yaml
    with:
      user: "{{user}}"
      count: 2
  - verify {{total}} for {{user}}
after:
  - press Escape
tags: [smoke, checkout]
meta: { owner: core }
`;

const invalidFlowSource = `sedum: 2
descriptin: typo
url: ftp://example.test/a
data:
  known: 1
before:
  - remember value as {{known}}
steps:
  - use: ./wrong.yaml
    with:
      arg: "{{missing}}"
  - type {{bad-name}} in "unfinished
goal: also invalid
verify: "{{missing}}"
after:
  - run: ./cleanup.ts
`;

const invalidModuleSource = `parameters: [user, user, bad-name]
url: /forbidden
steps:
  - use: ./nested.yaml
    with: { value: "{{missing}}" }
  - run: ./unsupported.ts
  - "verify {{user}} and {{other}}"
`;

const collisionInputs = [
  {
    path: "/project/z.test.yaml",
    source: "id: shared\nsteps: [click z]",
  },
  {
    path: "/project/a.test.yaml",
    source: "steps: [click a]",
  },
  {
    path: "/project/m.test.yaml",
    source: "id: shared\nsteps: [click m]",
  },
  {
    path: "/project/path-owner.test.yaml",
    source: "steps: [click path]",
  },
  {
    path: "/project/y.test.yaml",
    source: "id: path-owner.test.yaml\nsteps: [click y]",
  },
];

function nestedSource(levels: number): string {
  const mappings = Array.from(
    { length: levels },
    (_, index) => `${"  ".repeat(index + 1)}level${index}:`,
  ).join("\n");
  return `meta:\n${mappings}\n${"  ".repeat(levels + 1)}value: ok\nsteps: [click x]\n`;
}

function equivalentFlowSource(
  name: string,
  value: string,
  sentence: string,
  quote: "'" | '"',
): string {
  return `data:\n  ${name}: ${quote}${value}${quote}\nsteps:\n  - ${quote}${sentence}${quote}\n`;
}

function projectedDiagnostics(
  result: ReturnType<typeof parseFlow> | ReturnType<typeof parseModule>,
) {
  return result.diagnostics.map(({ code, message, fix, source }) => ({
    code,
    message,
    fix,
    col: source.col,
  }));
}

describe("flow loader characterization", () => {
  it("preserves the complete parsed shape of a valid authored flow", () => {
    expect(
      parseFlow(validFlowSource, "/project/tests/checkout.test.yaml", options),
    ).toMatchSnapshot();
  });

  it("preserves diagnostics, ordering, locations, candidate, and coverage for an invalid flow", () => {
    expect(
      parseFlow(invalidFlowSource, "/project/invalid.test.yaml", options),
    ).toMatchSnapshot();
  });

  it("preserves strict module parsing and all independently collected errors", () => {
    expect(
      parseModule(invalidModuleSource, "/project/account.yaml"),
    ).toMatchSnapshot();
  });

  it("preserves collision ownership and aggregate diagnostic order", () => {
    const result = validateFlows(collisionInputs, options);
    expect({
      diagnostics: result.diagnostics,
      coverage: result.coverage,
    }).toMatchSnapshot();
  });

  it("accepts nesting at the limit and diagnoses the first level beyond it", () => {
    const accepted = parseFlow(
      nestedSource(62),
      "/project/limit.test.yaml",
      options,
    );
    expect(accepted.diagnostics.map(({ code }) => code)).not.toContain(
      "yaml_nesting_limit",
    );

    const rejected = parseFlow(
      nestedSource(63),
      "/project/over.test.yaml",
      options,
    );
    expect(
      rejected.diagnostics.filter(({ code }) => code === "yaml_nesting_limit"),
    ).toEqual([
      {
        severity: "error",
        code: "yaml_nesting_limit",
        source: { file: "/project/over.test.yaml", line: 65, col: 136 },
        message: "This YAML value is nested too deeply.",
        fix: "Keep test structure within 64 mapping/list levels.",
      },
    ]);
  });

  propertyTest(
    "single- and double-quoted scalar forms parse identically",
    () => {
      hegel.test((tc) => {
        const [name, value] = tc.draw(
          gs.sampledFrom([
            ["user", "Ada"],
            ["account_2", "customer 42"],
            ["item", "checkout-button"],
          ] as const),
        );
        const sentence = tc.draw(
          gs.sampledFrom([
            `click {{${name}}}`,
            `verify {{${name}}} is visible`,
            "remember the value as {{remembered}}",
          ] as const),
        );
        const parse = (quote: "'" | '"') =>
          parseFlow(
            equivalentFlowSource(name, value, sentence, quote),
            "/project/equivalent.test.yaml",
            options,
          );
        if (JSON.stringify(parse("'")) !== JSON.stringify(parse('"')))
          throw new Error("Equivalent YAML scalar styles parsed differently");
      }, propertySettings);
    },
  );

  propertyTest(
    "invalid flow and module placeholders are diagnosed identically across scalar styles",
    () => {
      hegel.test((tc) => {
        const missing = tc.draw(
          gs.sampledFrom(["missing", "other_2", "unknownValue"] as const),
        );
        const quote = tc.draw(gs.sampledFrom(["'", '"'] as const));
        const sentence = `${quote}verify {{${missing}}}${quote}`;
        const flow = parseFlow(
          `steps:\n  - ${sentence}\n`,
          "/project/invalid.test.yaml",
          options,
        );
        const module = parseModule(
          `parameters: []\nsteps:\n  - ${sentence}\n`,
          "/project/invalid.module.yaml",
        );
        if (
          JSON.stringify(projectedDiagnostics(flow)) !==
          JSON.stringify(projectedDiagnostics(module))
        )
          throw new Error("Flow and module placeholder diagnostics drifted");
      }, propertySettings);
    },
  );
});
