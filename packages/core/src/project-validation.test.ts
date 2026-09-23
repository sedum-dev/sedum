import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileClassificationCache,
  NoopClassificationCache,
} from "./classification-cache.js";
import {
  MODEL_CHOICES,
  type ClassificationCache,
  type ClassificationProvider,
} from "./classification.js";
import {
  findIdentityCollisions,
  loadFlowFile,
  parseFlow,
} from "./flow-loader.js";
import { resolveFlowModules } from "./flow-modules.js";
import { discoverProjectFiles, walkSuiteFiles } from "./project-discovery.js";
import { displayPath, listTests } from "./project-listing.js";
import {
  dedupeDiagnostics,
  validateProject,
  type ProjectValidationResult,
} from "./project-validation.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-project-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  return root;
}

const VALID = {
  "valid/login.test.yaml":
    "id: login\ndescription: a customer signs in\ntags: [smoke, auth]\nurl: https://example.test/login\ndata:\n  user: alice\n  password: $SEDUM_TEST_UNSET_VARIABLE\nsteps:\n  - type {{user}} in the username field\n  - type {{password}} in the password field\n  - click the login button\n  - verify the products page is shown\n",
  "valid/path-id.test.yaml":
    "url: https://example.test/cart\nsteps:\n  - click the cart link\n",
};

/** One deliberately broken project covering every planted problem. */
const BROKEN = {
  ...VALID,
  "broken/bad-yaml.test.yaml": "steps:\n  - click a\n  bad: [\n",
  "broken/typo.test.yaml":
    "url: https://example.test\nsteps:\n  - click the button\nstepz: []\n",
  "broken/two-values.test.yaml":
    "url: https://example.test\ndata: {first: a, last: b}\nsteps:\n  - type {{first}} then {{last}} in the name field\n",
  "broken/unclear.test.yaml":
    "url: https://example.test\nsteps:\n  - add the cheapest item to the basket\n",
  "broken/uses-missing.test.yaml":
    "url: https://example.test\ndata: {first: a, last: b}\nbefore:\n  - use: ./missing.module.yaml\n  - use: ../modules/good.module.yaml\nsteps:\n  - tidy up the shopping list\n  - type {{first}} then {{last}} in the name field\n",
  "broken/uses-bad-a.test.yaml":
    "url: https://example.test\nsteps:\n  - use: ../modules/bad.module.yaml\n",
  "broken/uses-bad-b.test.yaml":
    "url: https://example.test\nsteps:\n  - use: ../modules/bad.module.yaml\n",
  "modules/good.module.yaml":
    "parameters: []\nsteps:\n  - make the banner go away\n",
  "modules/bad.module.yaml":
    "parameters: []\nsteps:\n  - type {{nobody}} in the field\n",
  "modules/orphan.module.yaml":
    "parameters: []\nsteps:\n  - do the checkout dance\n",
  "node_modules/pkg/ignored.test.yaml": "steps: [click x]\n",
  ".git/ignored.test.yaml": "steps: [click x]\n",
};

const throwingProvider = (): ClassificationProvider & { calls: number } => {
  const provider = {
    calls: 0,
    async classifyBatch() {
      provider.calls++;
      throw new Error("offline validation must not call the provider");
    },
  };
  return provider;
};

const readOnlyCache: ClassificationCache = {
  get: () => ({ answer: null, reason: "absent" }),
  put: () => {
    throw new Error("offline validation must not write the cache");
  },
  save: async () => {
    throw new Error("offline validation must not save the cache");
  },
};

async function validate(
  root: string,
  paths: readonly string[] = [],
): Promise<{ result: ProjectValidationResult; real: string }> {
  const discovery = await discoverProjectFiles(paths, { repoRoot: root });
  expect(discovery.problems).toEqual([]);
  const result = await validateProject(discovery, {
    repoRoot: discovery.root,
    mode: "offline",
    cache: readOnlyCache,
    provider: throwingProvider(),
  });
  return { result, real: discovery.root };
}

const located = (result: ProjectValidationResult, real: string) =>
  result.diagnostics.map(
    (item) =>
      `${displayPath(real, item.source.file)}:${item.source.line}:${item.source.col} ${item.code}`,
  );

describe("project discovery", () => {
  it("finds sorted tests and modules and skips dependency and dot folders", async () => {
    const root = await project(BROKEN);
    const discovery = await discoverProjectFiles([], { repoRoot: root });
    const real = await realpath(root);
    expect(discovery.root).toBe(real);
    expect(discovery.tests.map((file) => displayPath(real, file))).toEqual([
      "broken/bad-yaml.test.yaml",
      "broken/two-values.test.yaml",
      "broken/typo.test.yaml",
      "broken/unclear.test.yaml",
      "broken/uses-bad-a.test.yaml",
      "broken/uses-bad-b.test.yaml",
      "broken/uses-missing.test.yaml",
      "valid/login.test.yaml",
      "valid/path-id.test.yaml",
    ]);
    expect(discovery.modules.map((file) => displayPath(real, file))).toEqual([
      "modules/bad.module.yaml",
      "modules/good.module.yaml",
      "modules/orphan.module.yaml",
    ]);
  });

  it("honors explicit files and dot-directory roots, and deduplicates overlaps", async () => {
    const root = await project({
      ...VALID,
      ".suite/hidden.test.yaml": "steps: [click x]\n",
      "modules/one.module.yaml": "parameters: []\nsteps: [click x]\n",
    });
    const real = await realpath(root);
    const discovery = await discoverProjectFiles(
      ["valid", "valid/login.test.yaml", ".suite", "modules/one.module.yaml"],
      { repoRoot: root },
    );
    expect(discovery.problems).toEqual([]);
    expect(discovery.tests.map((file) => displayPath(real, file))).toEqual([
      ".suite/hidden.test.yaml",
      "valid/login.test.yaml",
      "valid/path-id.test.yaml",
    ]);
    expect(discovery.modules.map((file) => displayPath(real, file))).toEqual([
      "modules/one.module.yaml",
    ]);
  });

  it("reports missing, outside, and unsupported paths as usage problems", async () => {
    const root = await project({ ...VALID, "notes.txt": "hello" });
    const outside = await project({ "x.test.yaml": "steps: [click x]\n" });
    const discovery = await discoverProjectFiles(
      ["absent", outside, path.join(outside, "x.test.yaml"), "notes.txt"],
      { repoRoot: root },
    );
    expect(discovery.problems.map((item) => item.code)).toEqual([
      "missing_path",
      "outside_root",
      "outside_root",
      "unsupported_file",
    ]);
    expect(discovery.tests).toEqual([]);
  });

  it("accepts paths spelled through a symlinked root and keeps a test link name", async () => {
    const root = await project(VALID);
    const alias = path.join(
      await mkdtemp(path.join(tmpdir(), "sedum-alias-")),
      "link",
    );
    roots.push(path.dirname(alias));
    try {
      await symlink(root, alias, "dir");
      await symlink(
        path.join(root, "valid", "login.test.yaml"),
        path.join(root, "valid", "renamed.test.yaml"),
      );
    } catch {
      return; // Symlink creation may be unavailable on Windows.
    }
    const real = await realpath(root);
    const discovery = await discoverProjectFiles(
      [
        path.join(alias, "valid"),
        path.join(alias, "valid", "renamed.test.yaml"),
      ],
      { repoRoot: alias },
    );
    expect(discovery.problems).toEqual([]);
    expect(discovery.root).toBe(real);
    expect(discovery.tests.map((file) => displayPath(real, file))).toEqual([
      "valid/login.test.yaml",
      "valid/path-id.test.yaml",
      "valid/renamed.test.yaml",
    ]);
    const loaded = await loadFlowFile(discovery.tests[2]!, { repoRoot: real });
    expect(loaded.value?.explicitId).toBe("login");
  });

  it("accepts the unresolved tmpdir spelling while the root is its real path", async () => {
    const root = await project(VALID);
    const real = await realpath(root);
    const discovery = await discoverProjectFiles([path.join(root, "valid")], {
      repoRoot: real,
    });
    expect(discovery.problems).toEqual([]);
    const loaded = await loadFlowFile(discovery.tests[0]!, { repoRoot: real });
    expect(loaded.value?.identity).toBe("login");
    const pathIdentity = await loadFlowFile(discovery.tests[1]!, {
      repoRoot: real,
    });
    expect(pathIdentity.value?.identity).toBe("valid/path-id.test.yaml");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable directory instead of throwing",
    async () => {
      const root = await project({ ...VALID, "locked/a.test.yaml": "x" });
      await chmod(path.join(root, "locked"), 0o000);
      try {
        const discovery = await discoverProjectFiles([], { repoRoot: root });
        expect(discovery.problems.map((item) => item.code)).toEqual([
          "unreadable_directory",
        ]);
        expect(
          await walkSuiteFiles(path.join(root, "locked"), [".test.yaml"]),
        ).toEqual([]);
      } finally {
        await chmod(path.join(root, "locked"), 0o755);
      }
    },
  );
});

describe("partial module resolution", () => {
  it("keeps a never-executable candidate and every visited module file", async () => {
    const root = await project(BROKEN);
    const real = await realpath(root);
    const file = path.join(real, "broken", "uses-missing.test.yaml");
    const loaded = await loadFlowFile(file, { repoRoot: real });
    const partial = await resolveFlowModules(loaded, {
      repoRoot: real,
      partial: true,
    });
    expect(partial.value).toBeUndefined();
    expect(partial.coverage.modules).toBe("incomplete");
    expect(partial.moduleFiles).toEqual([
      path.join(real, "modules", "good.module.yaml"),
    ]);
    const [missing, good] = partial.candidate!.before;
    expect(missing).toMatchObject({
      kind: "module",
      use: "./missing.module.yaml",
    });
    expect(missing?.kind === "module" && missing.resolved).toBeFalsy();
    expect(good?.kind === "module" && good.resolved?.steps[0]).toMatchObject({
      kind: "sentence",
      text: "make the banner go away",
    });

    const strict = await resolveFlowModules(loaded, { repoRoot: real });
    expect(strict.value).toBeUndefined();
    expect(strict.candidate).toBeUndefined();
    expect(strict.diagnostics).toEqual(partial.diagnostics);
  });

  it("resolves a recoverable format-failed candidate only in partial mode", async () => {
    const root = await project({
      "t.test.yaml":
        "url: https://example.test\nsteps:\n  - click {{missing}}\n  - use: ./m.module.yaml\n",
      "m.module.yaml": "parameters: []\nsteps: [click x]\n",
    });
    const real = await realpath(root);
    const loaded = await loadFlowFile(path.join(real, "t.test.yaml"), {
      repoRoot: real,
    });
    expect(loaded.value).toBeUndefined();
    expect(loaded.candidate).toBeDefined();
    const strict = await resolveFlowModules(loaded, { repoRoot: real });
    expect(strict.moduleFiles).toEqual([]);
    const partial = await resolveFlowModules(loaded, {
      repoRoot: real,
      partial: true,
    });
    expect(partial.value).toBeUndefined();
    expect(partial.moduleFiles).toEqual([path.join(real, "m.module.yaml")]);
  });
});

describe("identity collisions", () => {
  const flow = (file: string, source: string) =>
    parseFlow(source, `/project/${file}`, { repoRoot: "/project" }).value!;

  it("reports repeated explicit ids and an id equal to another path identity", () => {
    const diagnostics = findIdentityCollisions([
      flow("b.test.yaml", "id: login\nsteps: [click x]\n"),
      flow("a.test.yaml", "id: login\nsteps: [click x]\n"),
      flow("c.test.yaml", "steps: [click x]\n"),
      flow("d.test.yaml", "id: c.test.yaml\nsteps: [click x]\n"),
      flow("e.test.yaml", "id: unique\nsteps: [click x]\n"),
    ]);
    expect(
      diagnostics.map((item) => [item.code, item.source.file, item.message]),
    ).toEqual([
      [
        "duplicate_id",
        "/project/b.test.yaml",
        expect.stringContaining("first used at /project/a.test.yaml:1:5"),
      ],
      [
        "duplicate_id",
        "/project/d.test.yaml",
        expect.stringContaining("path identity of /project/c.test.yaml"),
      ],
    ]);
  });

  it("finds nothing for distinct identities", () => {
    expect(
      findIdentityCollisions([
        flow("a.test.yaml", "id: a\nsteps: [click x]\n"),
        flow("b.test.yaml", "steps: [click x]\n"),
      ]),
    ).toEqual([]);
  });
});

describe("project validation", () => {
  it("reports every planted problem once while still checking valid files", async () => {
    const root = await project(BROKEN);
    const { result, real } = await validate(root);
    expect(located(result, real)).toEqual([
      "broken/bad-yaml.test.yaml:3:1 yaml_syntax",
      "broken/bad-yaml.test.yaml:4:1 yaml_syntax",
      "broken/two-values.test.yaml:4:5 invalid_operand",
      "broken/typo.test.yaml:4:1 unknown_key",
      "broken/unclear.test.yaml:3:5 unavailable",
      "broken/uses-missing.test.yaml:4:5 unreadable_module",
      "broken/uses-missing.test.yaml:7:5 unavailable",
      "broken/uses-missing.test.yaml:8:5 invalid_operand",
      "modules/bad.module.yaml:3:5 unknown_placeholder",
      "modules/good.module.yaml:3:5 unavailable",
      "modules/orphan.module.yaml:3:5 unavailable",
    ]);
    expect(result.counts).toEqual({
      tests: 9,
      modules: 3,
      unreferencedModules: 1,
      errors: 7,
      warnings: 0,
      notCheckedOffline: 4,
      operational: 0,
    });
    expect(result.fullyValidated).toBe(false);
    const modules = result.files.filter((file) => file.kind === "module");
    expect(
      modules.map((file) => [displayPath(real, file.file), file.reached]),
    ).toEqual([
      ["modules/bad.module.yaml", true],
      ["modules/good.module.yaml", true],
      ["modules/orphan.module.yaml", false],
    ]);
    const valid = result.files.find((file) => file.identity === "login");
    expect(valid?.coverage).toEqual({
      format: "passed",
      steps: "checked",
      modules: "not_needed",
    });
  });

  it("fully validates a clean project with an unset environment variable", async () => {
    const root = await project({
      ...VALID,
      "modules/login.module.yaml":
        "parameters: [who]\nsteps:\n  - type {{who}} in the username field\n",
      "valid/uses.test.yaml":
        "url: https://example.test\ndata: {name: bob}\nsteps:\n  - use: ../modules/login.module.yaml\n    with: {who: '{{name}}'}\n",
    });
    const { result } = await validate(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.counts.unreferencedModules).toBe(0);
    expect(result.fullyValidated).toBe(true);
  });

  it("checks entry URLs exactly as run does when a baseUrl setting is given", async () => {
    const root = await project({
      "absolute.test.yaml": "url: https://example.test\nsteps: [click x]\n",
      "none.test.yaml": "steps: [click x]\n",
      "relative.test.yaml": "url: /cart\nsteps: [click x]\n",
    });
    const discovery = await discoverProjectFiles([], { repoRoot: root });
    const check = (baseUrl?: string | null) =>
      validateProject(discovery, {
        repoRoot: discovery.root,
        mode: "offline",
        cache: readOnlyCache,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });
    const withoutBase = await check(null);
    expect(located(withoutBase, discovery.root)).toEqual([
      "none.test.yaml:1:1 invalid_entry_url",
      "relative.test.yaml:1:6 invalid_entry_url",
    ]);
    expect(withoutBase.fullyValidated).toBe(false);
    const withBase = await check("https://example.test/app/");
    expect(withBase.fullyValidated).toBe(true);
    // A leading-slash URL drops the base path: SED-27's warning, not an error.
    expect(
      withBase.diagnostics.map((item) => [item.severity, item.source.line]),
    ).toEqual([["warning", 1]]);
    // Library callers that pass no baseUrl setting opt out of the check.
    expect((await check()).fullyValidated).toBe(true);
  });

  it("reports cross-file identity collisions", async () => {
    const root = await project({
      "a.test.yaml": "id: same\nsteps: [click x]\n",
      "b.test.yaml": "id: same\nsteps: [click x]\n",
    });
    const { result, real } = await validate(root);
    expect(located(result, real)).toEqual(["b.test.yaml:1:5 duplicate_id"]);
    expect(result.fullyValidated).toBe(false);
  });

  it("leaves a committed classification cache untouched offline", async () => {
    const root = await project({
      ...VALID,
      ".sedum/classifications.json": "{}",
    });
    const cachePath = path.join(root, ".sedum", "classifications.json");
    const before = await stat(cachePath);
    const discovery = await discoverProjectFiles([], { repoRoot: root });
    const provider = throwingProvider();
    const result = await validateProject(discovery, {
      repoRoot: discovery.root,
      mode: "offline",
      cache: await FileClassificationCache.load(cachePath, "jev-latest"),
      provider,
    });
    expect(result.fullyValidated).toBe(true);
    expect(provider.calls).toBe(0);
    expect(await readFile(cachePath, "utf8")).toBe("{}");
    expect((await stat(cachePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("names an unreadable unreferenced module as an operational problem", async () => {
    const root = await project(VALID);
    const real = await realpath(root);
    const result = await validateProject(
      { tests: [], modules: [path.join(real, "gone.module.yaml")] },
      { repoRoot: real, mode: "offline", cache: new NoopClassificationCache() },
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "unreadable_file",
    ]);
    expect(result.counts.operational).toBe(1);
  });

  it("classifies misses online, then passes offline with zero provider calls", async () => {
    const root = await project({
      "t.test.yaml":
        "url: https://example.test\nsteps:\n  - tidy up the shopping list\n",
    });
    const cachePath = path.join(root, ".sedum", "classifications.json");
    const probabilities = Object.fromEntries(
      MODEL_CHOICES.map((choice) => [
        choice,
        choice === "click" ? 0.95 : 0.005,
      ]),
    ) as Record<(typeof MODEL_CHOICES)[number], number>;
    let requests = 0;
    const provider: ClassificationProvider = {
      async classifyBatch(sentences) {
        requests++;
        expect(sentences).toEqual(["tidy up the shopping list"]);
        return {
          answers: [
            {
              op: "click",
              probabilities,
              model: "jev-fixture",
              requestedModel: "jev-latest",
            },
          ],
          calls: [
            {
              requestedModel: "jev-latest",
              model: "jev-fixture",
              attempts: 1,
              usage: { inputTokens: 100, outputTokens: 5 },
              rate: null,
              successfulResponseCostUsd: null,
              totalCostUsd: null,
            },
          ],
        };
      },
    };
    const discovery = await discoverProjectFiles([], { repoRoot: root });
    const online = await validateProject(discovery, {
      repoRoot: discovery.root,
      mode: "allow-model",
      cache: await FileClassificationCache.load(cachePath, "jev-latest"),
      provider,
    });
    expect(online.fullyValidated).toBe(true);
    expect(online.calls).toHaveLength(1);
    const offlineProvider = throwingProvider();
    const offline = await validateProject(discovery, {
      repoRoot: discovery.root,
      mode: "offline",
      cache: await FileClassificationCache.load(cachePath, "jev-latest"),
      provider: offlineProvider,
    });
    expect(offline.fullyValidated).toBe(true);
    expect(requests).toBe(1);
    expect(offlineProvider.calls).toBe(0);
  });

  it("deduplicates identical diagnostics in a stable order", () => {
    const item = (line: number) => ({
      severity: "error" as const,
      code: "x",
      source: { file: "/a", line, col: 1 },
      message: "m",
      fix: "f",
    });
    expect(dedupeDiagnostics([item(2), item(1), item(2)])).toEqual([
      item(1),
      item(2),
    ]);
  });
});

describe("test listing", () => {
  it("lists valid tests and names invalid or colliding files", async () => {
    const root = await project({
      ...VALID,
      "broken/bad.test.yaml": "steps:\n  - click a\n  bad: [\n",
      "dup/a.test.yaml": "id: login\nsteps: [click x]\n",
    });
    const discovery = await discoverProjectFiles([], { repoRoot: root });
    const parsed = await Promise.all(
      discovery.tests.map(async (file) => ({
        file,
        result: await loadFlowFile(file, { repoRoot: discovery.root }),
      })),
    );
    const listing = listTests(parsed, { repoRoot: discovery.root });
    expect(listing.tests).toEqual([
      {
        id: "login",
        idSource: "explicit",
        file: "dup/a.test.yaml",
        description: null,
        tags: [],
      },
      {
        id: "valid/path-id.test.yaml",
        idSource: "path",
        file: "valid/path-id.test.yaml",
        description: null,
        tags: [],
      },
    ]);
    expect(
      listing.invalid.map((entry) => [
        entry.file,
        entry.diagnostics.map(
          (item) => `${item.line}:${item.col} ${item.code}`,
        ),
      ]),
    ).toEqual([
      ["broken/bad.test.yaml", ["3:1 yaml_syntax", "4:1 yaml_syntax"]],
      ["valid/login.test.yaml", ["1:5 duplicate_id"]],
    ]);
  });
});
