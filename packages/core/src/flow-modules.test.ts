import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { classifyParsedFlow } from "./flow-classification.js";
import { loadFlowFile, parseModule } from "./flow-loader.js";
import { resolveFlowModules } from "./flow-modules.js";
import {
  opaqueMatches,
  resolveData,
  resolveModuleBindings,
} from "./flow-values.js";
import { RuntimeValue } from "./step-executor.js";

describe("module definitions and graph", () => {
  it("accepts only parameters and steps with precise source positions", () => {
    const file = "/project/login.module.yaml";
    const good = parseModule(
      "parameters: [user, password]\nsteps:\n  - type {{user}} in the username field\n",
      file,
    );
    expect(good.value?.steps[0]).toMatchObject({
      source: { file, line: 3, col: 5 },
    });
    expect(good.diagnostics).toEqual([]);
    const bad = parseModule(
      "parameters: [user, user]\nurl: https://example.test\nsteps:\n  - type {{missing}} in the field\n",
      file,
    );
    expect(bad.value).toBeUndefined();
    expect(bad.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "duplicate_module_parameter",
        "unknown_module_key",
        "unknown_placeholder",
      ]),
    );
  });

  it("resolves nested modules before classification and preserves distinct occurrences", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-modules-"));
    try {
      await mkdir(path.join(root, "modules"));
      const file = path.join(root, "main.test.yaml");
      await writeFile(
        file,
        "data: {user: alice}\nsteps:\n  - use: ./modules/outer.module.yaml\n    with: {user: '{{user}}'}\n  - use: ./modules/outer.module.yaml\n    with: {user: bob}\n",
      );
      await writeFile(
        path.join(root, "modules/outer.module.yaml"),
        "parameters: [user]\nsteps:\n  - use: ./inner.module.yaml\n    with: {name: '{{user}}'}\n",
      );
      await writeFile(
        path.join(root, "modules/inner.module.yaml"),
        "parameters: [name]\nsteps:\n  - type {{name}} in the username field\n",
      );
      const graph = await resolveFlowModules(
        await loadFlowFile(file, { repoRoot: root }),
        { repoRoot: root },
      );
      expect(graph.coverage.modules).toBe("checked");
      expect(graph.diagnostics).toEqual([]);
      const classifyBatch = vi.fn();
      const classified = await classifyParsedFlow(graph, {
        mode: "allow-model",
        cache: new NoopClassificationCache(),
        provider: { classifyBatch },
      });
      expect(classified.coverage).toMatchObject({
        steps: "checked",
        modules: "checked",
      });
      expect(classified.value?.steps).toHaveLength(2);
      const first = classified.value?.steps[0];
      const second = classified.value?.steps[1];
      expect(first?.kind).toBe("module");
      expect(second?.kind).toBe("module");
      if (first?.kind !== "module" || second?.kind !== "module") return;
      expect(first.resolved?.id).not.toBe(second.resolved?.id);
      const inner = first.resolved?.steps[0];
      if (inner?.kind !== "module") return;
      const sentence = inner.resolved?.steps[0];
      expect(sentence).toMatchObject({
        kind: "sentence",
        op: "type",
        sourceStack: [
          { file, line: 3 },
          { file: path.join(root, "modules/outer.module.yaml"), line: 3 },
          { file: path.join(root, "modules/inner.module.yaml"), line: 3 },
        ],
      });
      expect(classifyBatch).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects cycles, escaped paths and missing arguments before launch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-graph-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sedum-outside-"));
    try {
      const file = path.join(root, "main.test.yaml");
      await writeFile(
        file,
        "steps:\n  - use: ./cycle.module.yaml\n  - use: ./escape.module.yaml\n  - use: ./required.module.yaml\n",
      );
      await writeFile(
        path.join(root, "cycle.module.yaml"),
        "parameters: []\nsteps:\n  - use: ./cycle.module.yaml\n",
      );
      await writeFile(
        path.join(outside, "escape.module.yaml"),
        "parameters: []\nsteps: [click outside]\n",
      );
      await symlink(
        path.join(outside, "escape.module.yaml"),
        path.join(root, "escape.module.yaml"),
      );
      await writeFile(
        path.join(root, "required.module.yaml"),
        "parameters: [user]\nsteps: [click login]\n",
      );
      const graph = await resolveFlowModules(
        await loadFlowFile(file, { repoRoot: root }),
        { repoRoot: root },
      );
      expect(graph.value).toBeUndefined();
      expect(graph.coverage.modules).toBe("incomplete");
      expect(graph.diagnostics.map((item) => item.code)).toEqual(
        expect.arrayContaining([
          "module_cycle",
          "module_outside_repo",
          "missing_module_argument",
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("accepts 32 nested call edges and rejects the 33rd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-module-depth-"));
    try {
      const file = path.join(root, "main.test.yaml");
      await writeFile(file, "steps:\n  - use: ./m1.module.yaml\n");
      for (let depth = 1; depth <= 32; depth++)
        await writeFile(
          path.join(root, `m${depth}.module.yaml`),
          depth === 32
            ? "parameters: []\nsteps: [verify final page]\n"
            : `parameters: []\nsteps:\n  - use: ./m${depth + 1}.module.yaml\n`,
        );
      const accepted = await resolveFlowModules(
        await loadFlowFile(file, { repoRoot: root }),
        { repoRoot: root },
      );
      expect(accepted.coverage.modules).toBe("checked");
      await writeFile(
        path.join(root, "m32.module.yaml"),
        "parameters: []\nsteps:\n  - use: ./m33.module.yaml\n",
      );
      await writeFile(
        path.join(root, "m33.module.yaml"),
        "parameters: []\nsteps: [verify final page]\n",
      );
      const rejected = await resolveFlowModules(
        await loadFlowFile(file, { repoRoot: root }),
        { repoRoot: root },
      );
      expect(rejected.value).toBeUndefined();
      expect(rejected.diagnostics.map((item) => item.code)).toContain(
        "module_depth_exceeded",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing and invalid module files without classifying any sentence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-invalid-modules-"));
    try {
      const file = path.join(root, "main.test.yaml");
      await writeFile(
        file,
        "steps:\n  - use: ./missing.module.yaml\n  - use: ./invalid.module.yaml\n",
      );
      await writeFile(
        path.join(root, "invalid.module.yaml"),
        "parameters: [x]\nsteps:\n  - type {{unknown}} in the field\n",
      );
      const graph = await resolveFlowModules(
        await loadFlowFile(file, { repoRoot: root }),
        { repoRoot: root },
      );
      expect(graph.value).toBeUndefined();
      expect(graph.diagnostics.map((item) => item.code)).toEqual(
        expect.arrayContaining(["unreadable_module", "unknown_placeholder"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects extra arguments, canonical suffix tricks and unreadable targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-module-edges-"));
    try {
      const file = path.join(root, "main.test.yaml");
      await writeFile(
        file,
        "steps:\n  - use: ./valid.module.yaml\n    with: {extra: true}\n  - use: ./alias.module.yaml\n  - use: ./directory.module.yaml\n",
      );
      await writeFile(
        path.join(root, "valid.module.yaml"),
        "parameters: []\nsteps: [verify valid page]\n",
      );
      await writeFile(
        path.join(root, "other.yaml"),
        "parameters: []\nsteps: [verify other page]\n",
      );
      await symlink(
        path.join(root, "other.yaml"),
        path.join(root, "alias.module.yaml"),
      );
      await mkdir(path.join(root, "directory.module.yaml"));
      const result = await resolveFlowModules(
        await loadFlowFile(file, { repoRoot: root }),
        { repoRoot: root },
      );
      expect(result.coverage.modules).toBe("incomplete");
      expect(result.diagnostics.map((item) => item.code)).toEqual(
        expect.arrayContaining([
          "unknown_module_argument",
          "invalid_module_path",
          "unreadable_module",
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("module occurrence bindings", () => {
  const source = { file: "test.yaml", line: 3, col: 15 };
  it("resolves live caller and environment values with secret provenance", () => {
    const values = resolveModuleBindings(
      ["user", "password"],
      {
        user: { value: "prefix-{{login}}", source },
        password: { value: "$PASSWORD", source },
      },
      {
        login: {
          value: new RuntimeValue("alice", "{{login}}"),
          sensitive: false,
        },
      },
      { PASSWORD: "secret" },
    );
    expect(values.user?.value.reveal()).toBe("prefix-alice");
    expect(values.user?.sensitive).toBe(false);
    expect(values.password?.value.reveal()).toBe("secret");
    expect(values.password?.sensitive).toBe(true);
    expect(JSON.stringify(values)).not.toContain("secret");
  });

  it("distinguishes unavailable remembered values from missing environment", () => {
    expect(() =>
      resolveModuleBindings(
        ["name"],
        { name: { value: "{{later}}", source } },
        {},
        {},
      ),
    ).toThrow(expect.objectContaining({ outcome: "failed" }));
    expect(() =>
      resolveModuleBindings(
        ["name"],
        { name: { value: "$ABSENT", source } },
        {},
        {},
      ),
    ).toThrow(expect.objectContaining({ outcome: "error" }));
  });

  it("preserves page-observed model visibility without exposing environment inputs", () => {
    const bindings = resolveModuleBindings(
      ["observed", "mixed"],
      {
        observed: { value: "item-{{id}}", source },
        mixed: { value: "{{id}}-$SECRET", source },
      },
      {
        id: {
          value: new RuntimeValue("42", "{{id}}"),
          sensitive: true,
          modelVisible: true,
        },
      },
      { SECRET: "private" },
    );
    expect(bindings.observed).toMatchObject({
      sensitive: true,
      modelVisible: true,
    });
    expect(bindings.mixed).toMatchObject({
      sensitive: true,
      modelVisible: false,
    });
  });

  it("tracks the raw environment component through a derived value", () => {
    const root = resolveData(
      { password: { value: "prefix-$SECRET", source } },
      { SECRET: "credential-987" },
    );
    expect(
      opaqueMatches("echo credential-987", Object.values(root)),
    ).toHaveLength(1);
    expect(JSON.stringify(root)).not.toContain("credential-987");
  });
});
