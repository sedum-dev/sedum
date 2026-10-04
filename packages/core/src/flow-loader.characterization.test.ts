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

describe("flow loader characterization", () => {
  it("preserves the complete parsed shape of a valid authored flow", () => {
    const result = parseFlow(
      `sedum: 1
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
`,
      "/project/tests/checkout.test.yaml",
      options,
    );

    expect(result).toMatchInlineSnapshot(`
      {
        "coverage": {
          "format": "passed",
          "modules": "not_checked",
          "steps": "not_checked",
        },
        "diagnostics": [
          {
            "code": "base_path_discarded",
            "fix": "Use a path without a leading slash if it should stay under the base path.",
            "message": "This leading-slash URL drops the configured base path.",
            "severity": "warning",
            "source": {
              "col": 6,
              "file": "/project/tests/checkout.test.yaml",
              "line": 4,
            },
          },
          {
            "code": "scalar_coercion",
            "fix": "Quote this data value if its written characters must be preserved.",
            "message": "YAML reads 01 as 1 before typing.",
            "severity": "warning",
            "source": {
              "col": 10,
              "file": "/project/tests/checkout.test.yaml",
              "line": 7,
            },
          },
        ],
        "value": {
          "after": [
            {
              "kind": "sentence",
              "phase": "after",
              "source": {
                "col": 5,
                "file": "/project/tests/checkout.test.yaml",
                "line": 19,
              },
              "text": "press Escape",
              "tokens": [],
            },
          ],
          "before": [
            {
              "kind": "sentence",
              "phase": "before",
              "source": {
                "col": 5,
                "file": "/project/tests/checkout.test.yaml",
                "line": 11,
              },
              "text": "remember the cart total as {{total}}",
              "tokens": [
                {
                  "end": 36,
                  "key": "total",
                  "kind": "placeholder",
                  "start": 27,
                  "text": "{{total}}",
                },
              ],
            },
          ],
          "data": {
            "count": {
              "source": {
                "col": 10,
                "file": "/project/tests/checkout.test.yaml",
                "line": 7,
              },
              "value": 1,
            },
            "empty": {
              "source": {
                "col": 10,
                "file": "/project/tests/checkout.test.yaml",
                "line": 9,
              },
              "value": null,
            },
            "enabled": {
              "source": {
                "col": 12,
                "file": "/project/tests/checkout.test.yaml",
                "line": 8,
              },
              "value": true,
            },
            "user": {
              "source": {
                "col": 9,
                "file": "/project/tests/checkout.test.yaml",
                "line": 6,
              },
              "value": "Ada",
            },
          },
          "description": "Checkout smoke test",
          "explicitId": "checkout",
          "file": "/project/tests/checkout.test.yaml",
          "idSource": {
            "col": 5,
            "file": "/project/tests/checkout.test.yaml",
            "line": 2,
          },
          "identity": "checkout",
          "meta": {
            "owner": "core",
          },
          "steps": [
            {
              "kind": "module",
              "phase": "steps",
              "source": {
                "col": 5,
                "file": "/project/tests/checkout.test.yaml",
                "line": 13,
              },
              "sourceStack": [
                {
                  "col": 5,
                  "file": "/project/tests/checkout.test.yaml",
                  "line": 13,
                },
              ],
              "use": "./checkout.module.yaml",
              "with": {
                "count": 2,
                "user": "{{user}}",
              },
              "withSources": {
                "count": {
                  "col": 14,
                  "file": "/project/tests/checkout.test.yaml",
                  "line": 16,
                },
                "user": {
                  "col": 13,
                  "file": "/project/tests/checkout.test.yaml",
                  "line": 15,
                },
              },
            },
            {
              "kind": "sentence",
              "phase": "steps",
              "source": {
                "col": 5,
                "file": "/project/tests/checkout.test.yaml",
                "line": 17,
              },
              "text": "verify {{total}} for {{user}}",
              "tokens": [
                {
                  "end": 16,
                  "key": "total",
                  "kind": "placeholder",
                  "start": 7,
                  "text": "{{total}}",
                },
                {
                  "end": 29,
                  "key": "user",
                  "kind": "placeholder",
                  "start": 21,
                  "text": "{{user}}",
                },
              ],
            },
          ],
          "tags": [
            "smoke",
            "checkout",
          ],
          "url": "/checkout",
          "urlSource": {
            "col": 6,
            "file": "/project/tests/checkout.test.yaml",
            "line": 4,
          },
          "version": 1,
        },
      }
    `);
  });

  it("preserves diagnostics, ordering, locations, candidate, and coverage for an invalid flow", () => {
    const result = parseFlow(
      `sedum: 2
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
`,
      "/project/invalid.test.yaml",
      options,
    );

    expect(result).toMatchInlineSnapshot(`
      {
        "coverage": {
          "format": "failed",
          "modules": "not_checked",
          "steps": "not_checked",
        },
        "diagnostics": [
          {
            "code": "invalid_test_mode",
            "fix": "Use \`steps\` for authored actions, or \`goal\` with a required \`verify\` claim.",
            "message": "This test has both a \`steps\` list and a \`goal\`; use one.",
            "severity": "error",
            "source": {
              "col": 1,
              "file": "/project/invalid.test.yaml",
              "line": 1,
            },
          },
          {
            "code": "unsupported_version",
            "fix": "Use \`sedum: 1\` or omit the marker for v1.",
            "message": "Unsupported Sedum format version 2.",
            "severity": "error",
            "source": {
              "col": 8,
              "file": "/project/invalid.test.yaml",
              "line": 1,
            },
          },
          {
            "code": "unknown_key",
            "fix": "Did you mean \`description\`?",
            "message": "Unknown top-level key \`descriptin\`.",
            "severity": "error",
            "source": {
              "col": 1,
              "file": "/project/invalid.test.yaml",
              "line": 2,
            },
          },
          {
            "code": "invalid_url",
            "fix": "Use an HTTP(S) URL or a relative path without spaces.",
            "message": "Invalid test URL.",
            "severity": "error",
            "source": {
              "col": 6,
              "file": "/project/invalid.test.yaml",
              "line": 3,
            },
          },
          {
            "code": "duplicate_remember_binding",
            "fix": "Choose a new binding name; remembered values cannot replace existing data.",
            "message": "{{known}} is already declared by data or an earlier remember step.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/invalid.test.yaml",
              "line": 7,
            },
          },
          {
            "code": "invalid_module_path",
            "fix": "Write \`use: path/to/login.module.yaml\`.",
            "message": "A use step must reference a .module.yaml file.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/invalid.test.yaml",
              "line": 9,
            },
          },
          {
            "code": "unknown_placeholder",
            "fix": "Declare \`missing\` under data or correct the placeholder name.",
            "message": "{{missing}} is not in this test's data.",
            "severity": "error",
            "source": {
              "col": 12,
              "file": "/project/invalid.test.yaml",
              "line": 11,
            },
          },
          {
            "code": "invalid_placeholder",
            "fix": "Write it as {{a_data_key}} with a closing }} and a valid key name.",
            "message": "Malformed placeholder.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/invalid.test.yaml",
              "line": 12,
            },
          },
          {
            "code": "unclosed_quote",
            "fix": "Close the literal with ".",
            "message": "Unclosed double-quoted literal.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/invalid.test.yaml",
              "line": 12,
            },
          },
          {
            "code": "unknown_placeholder",
            "fix": "Declare \`missing\` under data or correct the placeholder name.",
            "message": "{{missing}} is not in this test's data.",
            "severity": "error",
            "source": {
              "col": 9,
              "file": "/project/invalid.test.yaml",
              "line": 14,
            },
          },
          {
            "code": "unsupported_run",
            "fix": "Use a sentence step; SED-11 will define user-code steps.",
            "message": "The run step is not supported by the v1 loader.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/invalid.test.yaml",
              "line": 16,
            },
          },
        ],
      }
    `);
  });

  it("preserves strict module parsing and all independently collected errors", () => {
    const result = parseModule(
      `parameters: [user, user, bad-name]
url: /forbidden
steps:
  - use: ./nested.yaml
    with: { value: "{{missing}}" }
  - run: ./unsupported.ts
  - "verify {{user}} and {{other}}"
`,
      "/project/account.yaml",
    );

    expect(result).toMatchInlineSnapshot(`
      {
        "diagnostics": [
          {
            "code": "invalid_module_path",
            "fix": "Rename the file with the .module.yaml suffix.",
            "message": "A module file must end in .module.yaml.",
            "severity": "error",
            "source": {
              "col": 1,
              "file": "/project/account.yaml",
              "line": 1,
            },
          },
          {
            "code": "invalid_module_field",
            "fix": "Correct the module field for the v1 format.",
            "message": "Invalid \`parameters.2\`: Invalid string: must match pattern /^[A-Za-z_][A-Za-z0-9_]*$/.",
            "severity": "error",
            "source": {
              "col": 13,
              "file": "/project/account.yaml",
              "line": 1,
            },
          },
          {
            "code": "duplicate_module_parameter",
            "fix": "Keep each parameter name once.",
            "message": "Module parameter \`user\` is declared more than once.",
            "severity": "error",
            "source": {
              "col": 20,
              "file": "/project/account.yaml",
              "line": 1,
            },
          },
          {
            "code": "unknown_module_key",
            "fix": "Modules contain only \`parameters\` and \`steps\`.",
            "message": "Unknown module key \`url\`.",
            "severity": "error",
            "source": {
              "col": 1,
              "file": "/project/account.yaml",
              "line": 2,
            },
          },
          {
            "code": "invalid_module_field",
            "fix": "Correct the module field for the v1 format.",
            "message": "Invalid \`steps.1\`: Invalid input.",
            "severity": "error",
            "source": {
              "col": 3,
              "file": "/project/account.yaml",
              "line": 4,
            },
          },
          {
            "code": "invalid_module_path",
            "fix": "Write \`use: path/to/login.module.yaml\`.",
            "message": "A use step must reference a .module.yaml file.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/account.yaml",
              "line": 4,
            },
          },
          {
            "code": "unknown_placeholder",
            "fix": "Declare \`missing\` under data or correct the placeholder name.",
            "message": "{{missing}} is not in this test's data.",
            "severity": "error",
            "source": {
              "col": 20,
              "file": "/project/account.yaml",
              "line": 5,
            },
          },
          {
            "code": "unsupported_run",
            "fix": "Use a sentence step; SED-11 will define user-code steps.",
            "message": "The run step is not supported by the v1 loader.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/account.yaml",
              "line": 6,
            },
          },
          {
            "code": "unknown_placeholder",
            "fix": "Declare \`other\` under data or correct the placeholder name.",
            "message": "{{other}} is not in this test's data.",
            "severity": "error",
            "source": {
              "col": 5,
              "file": "/project/account.yaml",
              "line": 7,
            },
          },
        ],
      }
    `);
  });

  it("preserves collision ownership and aggregate diagnostic order", () => {
    const result = validateFlows(
      [
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
      ],
      options,
    );

    expect({ diagnostics: result.diagnostics, coverage: result.coverage })
      .toMatchInlineSnapshot(`
        {
          "coverage": {
            "format": "failed",
            "modules": "not_needed",
            "steps": "not_checked",
          },
          "diagnostics": [
            {
              "code": "duplicate_id",
              "fix": "Choose an id that is not another test's repository-relative path.",
              "message": "Explicit id \`path-owner.test.yaml\` equals the path identity of /project/path-owner.test.yaml.",
              "severity": "error",
              "source": {
                "col": 5,
                "file": "/project/y.test.yaml",
                "line": 1,
              },
            },
            {
              "code": "duplicate_id",
              "fix": "Give each test a unique explicit id or remove id to use the file path.",
              "message": "Duplicate explicit id \`shared\`; first used at /project/m.test.yaml:1:5.",
              "severity": "error",
              "source": {
                "col": 5,
                "file": "/project/z.test.yaml",
                "line": 1,
              },
            },
          ],
        }
      `);
  });

  it("accepts nesting at the limit and diagnoses the first level beyond it", () => {
    const nested = (levels: number) =>
      `meta:\n${Array.from({ length: levels }, (_, index) => `${"  ".repeat(index + 1)}level${index}:`).join("\n")}\n${"  ".repeat(levels + 1)}value: ok\nsteps: [click x]\n`;

    expect(
      parseFlow(
        nested(62),
        "/project/limit.test.yaml",
        options,
      ).diagnostics.map((diagnostic) => diagnostic.code),
    ).not.toContain("yaml_nesting_limit");
    expect(
      parseFlow(
        nested(63),
        "/project/over.test.yaml",
        options,
      ).diagnostics.filter(
        (diagnostic) => diagnostic.code === "yaml_nesting_limit",
      ),
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
            `remember the value as {{remembered}}`,
          ] as const),
        );
        const source = (quote: "'" | '"') =>
          `data:\n  ${name}: ${quote}${value}${quote}\nsteps:\n  - ${quote}${sentence}${quote}\n`;
        const single = parseFlow(
          source("'"),
          "/project/equivalent.test.yaml",
          options,
        );
        const double = parseFlow(
          source('"'),
          "/project/equivalent.test.yaml",
          options,
        );
        if (JSON.stringify(single) !== JSON.stringify(double))
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
        const project = (result: typeof flow | typeof module) =>
          result.diagnostics.map(({ code, message, fix, source }) => ({
            code,
            message,
            fix,
            col: source.col,
          }));
        if (JSON.stringify(project(flow)) !== JSON.stringify(project(module)))
          throw new Error("Flow and module placeholder diagnostics drifted");
      }, propertySettings);
    },
  );
});
