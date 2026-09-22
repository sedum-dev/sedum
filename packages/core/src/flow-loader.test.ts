import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverFlowFiles,
  loadFlowFile,
  parseFlow,
  validateFlows,
} from "./flow-loader.js";
import { formatFlowDiagnostic, isFullyValidated } from "./flow-types.js";

const options = { repoRoot: "/project" };

describe("flow loading", () => {
  it("loads a typed v1 flow with parser-derived positions and declared data", () => {
    const source = `sedum: 1
id: login-smoke
description: A login test
url: /login
tags: [smoke]
meta: { owner: checkout }
data:
  user: standard_user
  password: \${SAUCE_PASSWORD}
before:
  - use: modules/login.module.yaml
    with: { user: "{{user}}" }
steps:
  - click the login button
  - click the login button
  - >
    verify the products
    are shown
after:
  - press Escape
`;
    const result = parseFlow(source, "/project/tests/login.test.yaml", options);
    expect(result.diagnostics).toEqual([]);
    expect(result.coverage).toEqual({
      format: "passed",
      steps: "not_checked",
      modules: "not_checked",
    });
    const flow = result.value!;
    expect(flow).toMatchObject({
      version: 1,
      identity: "login-smoke",
      explicitId: "login-smoke",
      url: "/login",
      tags: ["smoke"],
    });
    expect(flow.data.password!.value).toBe("${SAUCE_PASSWORD}");
    expect(flow.before[0]).toMatchObject({
      kind: "module",
      source: { file: "/project/tests/login.test.yaml", line: 11 },
    });
    expect(flow.steps.map((step) => step.source.line)).toEqual([14, 15, 16]);
    expect(flow.steps[0]).toMatchObject({
      kind: "sentence",
      text: "click the login button",
    });
    expect(flow.steps[2]).toMatchObject({
      kind: "sentence",
      text: "verify the products are shown\n",
    });
    expect(flow.after[0]!.source.line).toBe(20);
  });

  it("defaults the version and identity to the repository-relative path", () => {
    const result = parseFlow(
      "steps:\n  - click login\n",
      "/project/tests/login.test.yaml",
      options,
    );
    expect(result.value?.identity).toBe("tests/login.test.yaml");
    expect(result.value?.version).toBe(1);
    expect(result.coverage.modules).toBe("not_needed");
    expect(isFullyValidated(result.coverage, result.diagnostics)).toBe(false);
  });

  it("reports unknown, reserved, obsolete, and missing fields with fixes", () => {
    const source =
      "sedum: 2\nname: login\nfileType: sedum/test/v1\ndatas: {}\ngoal: log in\n";
    const result = parseFlow(source, "/project/bad.test.yaml", options);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "unsupported_version",
    );
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "reserved_key",
    );
    expect(
      result.diagnostics.filter((item) => item.code === "unknown_key"),
    ).toHaveLength(3);
    expect(
      result.diagnostics.find((item) => item.message.includes("`name`"))?.fix,
    ).toContain("description");
    expect(
      result.diagnostics.find((item) => item.message.includes("`fileType`"))
        ?.fix,
    ).toContain("sedum: 1");
    expect(
      result.diagnostics.find((item) => item.message.includes("`datas`"))?.fix,
    ).toContain("data");
    expect(
      result.diagnostics.find((item) =>
        item.message.includes("needs a `steps`"),
      )?.source,
    ).toMatchObject({ file: "/project/bad.test.yaml", line: 1 });
    expect(formatFlowDiagnostic(result.diagnostics[0]!)).toMatch(
      /^\/project\/bad\.test\.yaml:\d+:\d+:/,
    );
  });

  it("rejects duplicate keys, malformed YAML, non-mapping roots, aliases and custom tags", () => {
    const duplicate = parseFlow(
      "steps:\n  - click one\nsteps:\n  - click two\n",
      "/project/duplicate.test.yaml",
      options,
    );
    expect(duplicate.diagnostics.map((item) => item.code)).toContain(
      "duplicate_key",
    );
    expect(duplicate.value).toBeUndefined();
    expect(
      parseFlow("steps: [", "/project/broken.test.yaml", options).coverage
        .format,
    ).toBe("failed");
    expect(
      parseFlow("- a\n- b", "/project/list.test.yaml", options).diagnostics[0]
        ?.code,
    ).toBe("invalid_root");
    expect(
      parseFlow(
        "data: {x: &x hi, y: *x}\nsteps: [click one]",
        "/project/alias.test.yaml",
        options,
      ).diagnostics.map((item) => item.code),
    ).toContain("unsupported_alias");
    expect(
      parseFlow(
        "data: {x: !secret hi}\nsteps: [click one]",
        "/project/tag.test.yaml",
        options,
      ).diagnostics.map((item) => item.code),
    ).toContain("unsupported_tag");
  });

  it("collects separate type and lexical errors without losing step locations", () => {
    const source = `data:
  user: [wrong]
steps:
  - 42
  - type {{missing}} in the field
  - type {{bad-name}} in the field
  - type "unfinished
`;
    const result = parseFlow(source, "/project/bad.test.yaml", options);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "invalid_field",
        "unknown_placeholder",
        "invalid_placeholder",
        "unclosed_quote",
      ]),
    );
    expect(
      result.diagnostics
        .filter((item) => item.source.line === 5)
        .map((item) => item.code),
    ).toContain("unknown_placeholder");
    expect(
      result.diagnostics
        .filter((item) => item.source.line === 7)
        .map((item) => item.code),
    ).toContain("unclosed_quote");
  });

  it("preserves CRLF and block-scalar positions without text search", () => {
    const source =
      "steps:\r\n  - click same\r\n  - click same\r\n  - |\r\n    verify a line\r\n    and another\r\n";
    const result = parseFlow(source, "/project/lines.test.yaml", options);
    expect(
      result.value?.steps.map((step) => [step.source.line, step.source.col]),
    ).toEqual([
      [2, 5],
      [3, 5],
      [4, 5],
    ]);
  });

  it("checks URLs but allows an omitted URL for a later config base", () => {
    expect(
      parseFlow("steps: [click one]", "/project/no-url.test.yaml", options)
        .value,
    ).toBeDefined();
    expect(
      parseFlow(
        "url: https://example.com/login\nsteps: [click one]",
        "/project/url.test.yaml",
        options,
      ).value,
    ).toBeDefined();
    const warned = parseFlow(
      "url: /login\nsteps: [click one]",
      "/project/warn.test.yaml",
      { ...options, baseUrl: "https://example.com/app/" },
    );
    expect(warned.value).toBeDefined();
    expect(warned.diagnostics.map((item) => item.code)).toContain(
      "base_path_discarded",
    );
    expect(
      parseFlow(
        "url: ftp://example.com\nsteps: [click one]",
        "/project/ftp.test.yaml",
        options,
      ).diagnostics.map((item) => item.code),
    ).toContain("invalid_url");
    expect(
      parseFlow(
        'url: "http://["\nsteps: [click one]',
        "/project/broken-url.test.yaml",
        options,
      ).diagnostics.map((item) => item.code),
    ).toContain("invalid_url");
  });

  it("rejects data keys that cannot be referenced by placeholders", () => {
    const result = parseFlow(
      "data: { bad-key: x }\nsteps: [click x]",
      "/project/key.test.yaml",
      options,
    );
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "invalid_field",
    );
  });

  it("does not accept a whitespace-only required step", () => {
    const result = parseFlow(
      'steps:\n  - "   "\n',
      "/project/empty.test.yaml",
      options,
    );
    expect(result.value).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      { code: "invalid_field", source: { line: 2 } },
    ]);
  });

  it("bounds deeply nested YAML input without crashing", () => {
    const nested = `${"meta:\n"}${Array.from({ length: 70 }, (_, index) => `${"  ".repeat(index + 1)}level:`).join("\n")}\nsteps: [click x]\n`;
    const result = parseFlow(nested, "/project/deep.test.yaml", options);
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "yaml_nesting_limit",
    );
  });

  it("only reports full success after composed checks complete", () => {
    const parsed = parseFlow(
      "steps: [click x]",
      "/project/check.test.yaml",
      options,
    );
    expect(isFullyValidated(parsed.coverage, parsed.diagnostics)).toBe(false);
    expect(
      isFullyValidated(
        { format: "passed", steps: "checked", modules: "not_needed" },
        [],
      ),
    ).toBe(true);
    expect(
      isFullyValidated(
        { format: "passed", steps: "incomplete", modules: "not_needed" },
        [],
      ),
    ).toBe(false);
  });

  it("rejects nonstring YAML keys and a test outside the repository root", () => {
    const badKey = parseFlow(
      "? [a, b]\n: value\nsteps: [click x]",
      "/project/key.test.yaml",
      options,
    );
    expect(badKey.diagnostics.map((item) => item.code)).toContain(
      "invalid_mapping_key",
    );
    const outside = parseFlow(
      "steps: [click x]",
      "/elsewhere/outside.test.yaml",
      options,
    );
    expect(outside.diagnostics.map((item) => item.code)).toContain(
      "file_outside_repo",
    );
  });

  it("keeps aggregate format coverage green only for structurally valid files", () => {
    const result = validateFlows(
      [
        { path: "/project/one.test.yaml", source: "steps: [click x]" },
        {
          path: "/project/two.test.yaml",
          source: "steps:\n  - use: ./shared.module.yaml\n",
        },
      ],
      options,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.coverage).toEqual({
      format: "passed",
      steps: "not_checked",
      modules: "not_checked",
    });
    expect(isFullyValidated(result.coverage, result.diagnostics)).toBe(false);
  });

  it("reports invalid module paths and placeholders in module arguments", () => {
    const result = parseFlow(
      "steps:\n  - use: ./bad.yaml\n    with: { user: '{{missing}}' }\n",
      "/project/module.test.yaml",
      options,
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["invalid_module_path", "unknown_placeholder"]),
    );
    expect(result.coverage.modules).toBe("not_checked");
  });

  it("rejects unimplemented run and remember steps and retains unresolved modules", () => {
    const run = parseFlow(
      "steps:\n  - run: ./setup.ts\n",
      "/project/run.test.yaml",
      options,
    );
    expect(run.diagnostics.map((item) => item.code)).toContain(
      "unsupported_run",
    );
    const remember = parseFlow(
      "steps:\n  - remember the price as {{price}}\n",
      "/project/remember.test.yaml",
      options,
    );
    expect(remember.diagnostics.map((item) => item.code)).toContain(
      "unsupported_remember",
    );
    const module = parseFlow(
      "steps:\n  - use: ./missing.module.yaml\n",
      "/project/module.test.yaml",
      options,
    );
    expect(module.value?.steps[0]).toMatchObject({
      kind: "module",
      source: { line: 2 },
    });
    expect(module.coverage.modules).toBe("not_checked");
    expect(
      isFullyValidated(
        {
          format: "passed",
          steps: "checked",
          modules: module.coverage.modules,
        },
        module.diagnostics,
      ),
    ).toBe(false);
  });

  it("finds duplicate explicit ids across files while retaining other diagnostics", () => {
    const result = validateFlows(
      [
        {
          path: "/project/a.test.yaml",
          source: "id: same\nsteps: [click one]",
        },
        {
          path: "/project/b.test.yaml",
          source: "id: same\nsteps: [click two]",
        },
        { path: "/project/c.test.yaml", source: "steps: [" },
      ],
      options,
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["duplicate_id", "yaml_syntax"]),
    );
    expect(
      result.diagnostics.find((item) => item.code === "duplicate_id")?.source,
    ).toMatchObject({ file: "/project/b.test.yaml", line: 1 });
    expect(result.coverage.format).toBe("failed");
  });

  it("discovers only sorted test files recursively and reports unreadable explicit files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedum-flow-"));
    try {
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "b.test.yaml"), "steps: [click b]");
      await writeFile(
        path.join(root, "nested", "a.test.yaml"),
        "steps: [click a]",
      );
      await writeFile(
        path.join(root, "nested", "shared.module.yaml"),
        "steps: [click x]",
      );
      expect(
        (await discoverFlowFiles(root)).map((file) =>
          path.relative(root, file),
        ),
      ).toEqual(["b.test.yaml", path.join("nested", "a.test.yaml")]);
      expect(
        (await loadFlowFile(path.join(root, "b.test.yaml"), { repoRoot: root }))
          .value?.identity,
      ).toBe("b.test.yaml");
      expect(
        (
          await loadFlowFile(path.join(root, "absent.test.yaml"), {
            repoRoot: root,
          })
        ).diagnostics[0]?.code,
      ).toBe("unreadable_file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
