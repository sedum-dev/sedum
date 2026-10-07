import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ProviderError, RunRecorder } from "@sedum-dev/core";
import { readBranchDiff, selectAffectedTests } from "./affected-selection.js";
import { runCli } from "./run-cli.js";
import { assertAffectedSnapshot, readCommittedSource } from "./affected-git.js";
import { loadProjectConfig } from "./config.js";
import { discoverRunTests } from "./run-selection.js";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (file: string, source: string) =>
  writeFile(path.join(root, file), source);
function commit() {
  git("add", ".");
  git("commit", "-m", "fixture change");
}
async function fixture(branch = "main") {
  root = await mkdtemp(path.join(tmpdir(), "sedum-affected-"));
  git("init", "-b", branch);
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  await mkdir(path.join(root, "tests"));
  await write("sedum.config.yaml", "{}\n");
  await write("app.ts", "export const cartTotal = 10;\n");
  await write(
    "tests/cart.test.yaml",
    "id: cart\nsteps:\n  - use: login.module.yaml\n  - verify cart total\n",
  );
  await write(
    "tests/login.module.yaml",
    "parameters: []\nsteps: [click sign in]\n",
  );
  await write(
    "tests/profile.test.yaml",
    "id: profile\nsteps: [verify profile name]\n",
  );
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
}
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it("uses pinned committed HEAD and excludes base-only changes from a subdirectory", async () => {
  await fixture();
  const ancestor = git("rev-parse", "HEAD");
  git("checkout", "main");
  await write("base-only.ts", "unrelated main work\n");
  git("add", ".");
  git("commit", "-m", "advance main");
  git("checkout", "feature");
  await write("app.ts", "export const cartTotal = 20;\n");
  git("commit", "-am", "feature change");
  git("config", "diff.relative", "true");
  const diff = await readBranchDiff(path.join(root, "tests"));
  expect(diff.mergeBase).toBe(ancestor);
  expect(diff.head).toBe(git("rev-parse", "HEAD"));
  expect(diff.changed).toEqual(["app.ts"]);
  expect(diff.diff).toContain("+export const cartTotal = 20;");
  expect(diff.diff).not.toContain("base-only");
});

it("supports master, remote main, and explicit refs, and refuses invalid refs and untracked files", async () => {
  await fixture("master");
  expect((await readBranchDiff(root)).base).toBe("refs/heads/master");
  git("update-ref", "refs/remotes/origin/main", "master");
  expect((await readBranchDiff(root)).base).toBe("refs/remotes/origin/main");
  expect((await readBranchDiff(root, "master")).base).toBe("master");
  await expect(readBranchDiff(root, "--output=bad")).rejects.toThrow(
    "complete Git diff",
  );
  await write("new.ts", "new code");
  await expect(readBranchDiff(root)).rejects.toThrow("Untracked");
  // Five snapshot reads spawn many Git processes; Windows CI needs more than 5s.
}, 30_000);

it("refuses binary and submodule changes rather than scoring incomplete text", async () => {
  await fixture();
  await write("binary.dat", "\0binary");
  commit();
  await expect(readBranchDiff(root)).rejects.toThrow("Binary or submodule");
  await rm(path.join(root, "binary.dat"));
  commit();
  git("clone", "--shared", root, "vendor");
  git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git("rev-parse", "HEAD")},vendor`,
  );
  git("commit", "-m", "add submodule");
  await expect(readBranchDiff(root)).rejects.toThrow("Binary or submodule");
  expect(
    (await readBranchDiff(root, undefined, undefined, ["vendor"])).diff,
  ).toBe("");
  await write("vendor/app.ts", "dirty submodule\n");
  await expect(
    readBranchDiff(root, undefined, undefined, ["vendor"]),
  ).rejects.toThrow("dirty submodules");
});

it("includes complete test and module source, selects the exact threshold, and skips below it", async () => {
  await fixture();
  await write("app.ts", "export const cartTotal = 99;\n");
  commit();
  const scoreRelevance = vi.fn(async () => ({
    probabilities: [0.1, 0.099],
    calls: [],
  }));
  const selection = await selectAffectedTests({
    cwd: root,
    paths: [],
    filters: {},
    threshold: 0.1,
    createProvider: () => ({ scoreRelevance }),
  });
  expect(selection.tests.map((test) => test.selected)).toEqual([true, false]);
  expect(scoreRelevance).toHaveBeenCalledWith(
    expect.stringContaining("+export const cartTotal = 99;"),
    [
      {
        file: "tests/cart.test.yaml",
        source: await readFile(path.join(root, "tests/cart.test.yaml"), "utf8"),
        modules: [
          {
            file: "tests/login.module.yaml",
            source: "parameters: []\nsteps: [click sign in]\n",
          },
        ],
      },
      {
        file: "tests/profile.test.yaml",
        source: "id: profile\nsteps: [verify profile name]\n",
        modules: [],
      },
    ],
    undefined,
  );
});

it("keeps module paths project-relative when the project root is symlinked", async () => {
  await fixture();
  const aliasDirectory = await mkdtemp(
    path.join(tmpdir(), "sedum-root-alias-"),
  );
  try {
    const alias = path.join(aliasDirectory, "project");
    await symlink(root, alias, "junction");
    await write("app.ts", "changed\n");
    commit();
    const scoreRelevance = vi.fn(async () => ({
      probabilities: [0.9, 0],
      calls: [],
    }));
    await selectAffectedTests({
      cwd: alias,
      paths: [],
      filters: {},
      threshold: 0.1,
      createProvider: () => ({ scoreRelevance }),
    });
    expect(scoreRelevance).toHaveBeenCalledWith(
      expect.any(String),
      [
        expect.objectContaining({
          file: "tests/cart.test.yaml",
          modules: [
            {
              file: "tests/login.module.yaml",
              source: "parameters: []\nsteps: [click sign in]\n",
            },
          ],
        }),
        expect.objectContaining({
          file: "tests/profile.test.yaml",
          modules: [],
        }),
      ],
      undefined,
    );
  } finally {
    await rm(aliasDirectory, { recursive: true, force: true });
  }
});

it("always includes changed tests and module dependents even when Jev returns zero", async () => {
  await fixture();
  await write(
    "tests/login.module.yaml",
    "parameters: []\nsteps: [click log in]\n",
  );
  await write(
    "tests/profile.test.yaml",
    "id: profile\nsteps: [verify new profile]\n",
  );
  commit();
  const selection = await selectAffectedTests({
    cwd: root,
    paths: [],
    filters: {},
    threshold: 1,
    createProvider: () => ({
      scoreRelevance: async () => ({ probabilities: [0, 0], calls: [] }),
    }),
  });
  expect(selection.tests.map((test) => [test.selected, test.reason])).toEqual([
    [true, "test-or-module-changed"],
    [true, "test-or-module-changed"],
  ]);
});

it("scores a TypeScript test file once and forces it when it changed", async () => {
  await fixture();
  const source = (claim: string) =>
    `import { test } from "sedum-cli";\ntest("a", async ({ ai }) => { await ai("verify ${claim}"); });\ntest("b", async ({ ai }) => { await ai("verify cart total"); });\n`;
  await write("tests/shop.test.ts", source("the shop"));
  git("add", ".");
  git("commit", "-m", "add typescript tests");
  await write("tests/shop.test.ts", source("the new shop"));
  commit();
  const scored: string[] = [];
  const selection = await selectAffectedTests({
    cwd: root,
    paths: [],
    filters: {},
    threshold: 1,
    createProvider: () => ({
      scoreRelevance: async (_diff, tests) => {
        scored.push(...tests.map((test) => test.file));
        return { probabilities: tests.map(() => 0), calls: [] };
      },
    }),
  });
  expect(scored).toEqual(["tests/cart.test.yaml", "tests/profile.test.yaml"]);
  expect(
    selection.tests.map((test) => [test.file, test.selected, test.reason]),
  ).toEqual([
    ["tests/cart.test.yaml", false, "model"],
    ["tests/profile.test.yaml", false, "model"],
    ["tests/shop.test.ts", true, "test-or-module-changed"],
  ]);
});

it("forces dependents of a retargeted module symlink even with zero relevance", async () => {
  await fixture();
  await write(
    "tests/login-v1.module.yaml",
    "parameters: []\nsteps: [click sign in]\n",
  );
  await write(
    "tests/login-v2.module.yaml",
    "parameters: []\nsteps: [click log in]\n",
  );
  await rm(path.join(root, "tests/login.module.yaml"));
  await symlink(
    "login-v1.module.yaml",
    path.join(root, "tests/login.module.yaml"),
  );
  git("add", ".");
  git("commit", "-m", "module symlink baseline");
  git("branch", "-f", "main", "HEAD");
  await rm(path.join(root, "tests/login.module.yaml"));
  await symlink(
    "login-v2.module.yaml",
    path.join(root, "tests/login.module.yaml"),
  );
  // A deleted source also exercises the unresolved-path fallback.
  await rm(path.join(root, "app.ts"));
  commit();
  const selection = await selectAffectedTests({
    cwd: root,
    paths: [],
    filters: {},
    threshold: 1,
    createProvider: () => ({
      scoreRelevance: async () => ({ probabilities: [0, 0], calls: [] }),
    }),
  });
  expect(selection.tests).toEqual([
    {
      file: "tests/cart.test.yaml",
      probability: 1,
      selected: true,
      reason: "test-or-module-changed",
    },
    {
      file: "tests/profile.test.yaml",
      probability: 0,
      selected: false,
      reason: "model",
    },
  ]);
});

it("routes affected selection through the configured Clef credentials only", async () => {
  await fixture();
  await write(
    "sedum.config.yaml",
    "provider:\n  name: clef\n  model: clef-flash\n",
  );
  await write(
    ".env",
    "CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nCLOUDFLARE_AUTH_TOKEN=clef-token\nTYPESAFE_API_KEY=jev-token\n",
  );
  await write(".git/info/exclude", ".env\n");
  await write("app.ts", "export const cartTotal = 99;\n");
  commit();
  const createProvider = vi.fn(() => ({
    scoreRelevance: async () => ({ probabilities: [0, 0], calls: [] }),
  }));
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_AUTH_TOKEN", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("TYPESAFE_API_KEY", "");
  try {
    await selectAffectedTests({
      cwd: root,
      paths: [],
      filters: {},
      threshold: 0.5,
      createProvider,
    });
  } finally {
    vi.unstubAllEnvs();
  }
  expect(createProvider).toHaveBeenCalledWith(
    expect.objectContaining({
      providerName: "clef",
      providerModel: "clef-flash",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      apiKey: "clef-token",
    }),
  );
  expect(JSON.stringify(createProvider.mock.calls)).not.toContain("jev-token");
});

it("reports rejected Clef affected-selection credentials without leaking the token or naming TypeSafe", async () => {
  await fixture();
  await write("sedum.config.yaml", "provider: { name: clef, model: clef }\n");
  await write(
    ".env",
    "CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef\nCLOUDFLARE_API_TOKEN=affected-sentinel-secret\n",
  );
  await write(".git/info/exclude", ".env\n");
  await write("app.ts", "export const cartTotal = 99;\n");
  commit();
  vi.stubEnv("CLOUDFLARE_AUTH_TOKEN", "");
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  const error = await selectAffectedTests({
    cwd: root,
    paths: [],
    filters: {},
    threshold: 0.5,
    createProvider: () => ({
      scoreRelevance: async () => {
        throw new ProviderError(
          "authentication",
          "rejected affected-sentinel-secret",
        );
      },
    }),
  }).catch((value) => value);
  expect(error).toMatchObject({
    message: expect.stringContaining("Cloudflare rejected"),
  });
  expect(error.message).toContain("Workers AI Read and Edit");
  expect(error.message).toContain("CLOUDFLARE_API_TOKEN");
  expect(error.message).not.toContain("TYPESAFE_API_KEY");
  expect(error.message).not.toContain("affected-sentinel-secret");
});

it("does not call Jev or execute the full suite when the diff or selection is empty", async () => {
  await fixture();
  const scoreRelevance = vi.fn(async () => ({
    probabilities: [0, 0],
    calls: [],
  }));
  const executeRun = vi.fn();
  const runtime = {
    cwd: root,
    executeRun,
    createRelevanceProvider: () => ({ scoreRelevance }),
  };
  expect((await runCli(["run", "--affected"], "test", runtime)).exitCode).toBe(
    0,
  );
  expect(scoreRelevance).not.toHaveBeenCalled();
  await write("app.ts", "changed\n");
  commit();
  const output = await runCli(["run", "--affected"], "test", runtime);
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toContain("No relevant tests selected");
  expect(executeRun).not.toHaveBeenCalled();
});

it("previews JSON, passes only selected paths to the runner, and preserves failure exit codes", async () => {
  await fixture();
  await write("app.ts", "changed\n");
  commit();
  const recorder = new RunRecorder(async () => undefined, "affected-test");
  await recorder.start();
  await recorder.startTest({ id: "cart", file: "tests/cart.test.yaml" });
  await recorder.finish({
    code: "execution_error",
    message: "Browser disconnected.",
  });
  const executeRun = vi.fn(async () => ({
    result: recorder.snapshot,
    artifacts: {
      progressPath: "progress.json",
      resultPath: "result.json",
      authoritative: true,
    },
    diagnostic: null,
  }));
  const runtime = {
    cwd: root,
    executeRun,
    createRelevanceProvider: () => ({
      scoreRelevance: async () => ({ probabilities: [0.3, 0.299], calls: [] }),
    }),
  };
  const preview = await runCli(
    ["run", "--affected", "--selection-only"],
    "test",
    runtime,
  );
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(preview.stdout).threshold).toBe(0.3);
  expect(
    JSON.parse(preview.stdout).tests.map(
      (test: { selected: boolean }) => test.selected,
    ),
  ).toEqual([true, false]);
  expect(executeRun).not.toHaveBeenCalled();
  const run = await runCli(
    [
      "run",
      "--affected",
      "--reporter",
      "json",
      "--shard-index",
      "1",
      "--shard-count",
      "1",
      "--parallel",
      "2",
    ],
    "test",
    runtime,
  );
  expect(run.exitCode).toBe(3);
  expect(executeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      paths: ["tests/cart.test.yaml"],
      shard: { index: 1, count: 1 },
      parallel: 2,
    }),
  );
});

it("honors an explicit affected threshold instead of the default", async () => {
  await fixture();
  await write("app.ts", "changed\n");
  commit();
  const preview = await runCli(
    ["run", "--affected", "--selection-only", "--threshold", "0.1"],
    "test",
    {
      cwd: root,
      createRelevanceProvider: () => ({
        scoreRelevance: async () => ({
          probabilities: [0.1, 0.099],
          calls: [],
        }),
      }),
    },
  );
  expect(preview.exitCode).toBe(0);
  expect(JSON.parse(preview.stdout)).toMatchObject({
    threshold: 0.1,
    tests: [{ selected: true }, { selected: false }],
  });
});

it.each([false, true])(
  "rejects affected multi-shard selection before provider creation or execution (preview: %s)",
  async (preview) => {
    const createRelevanceProvider = vi.fn();
    const executeRun = vi.fn();
    const output = await runCli(
      [
        "run",
        "--affected",
        "--shard-index",
        "1",
        "--shard-count",
        "2",
        ...(preview ? ["--selection-only"] : []),
      ],
      "test",
      { createRelevanceProvider, executeRun },
    );
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain(
      "--affected cannot be combined with multiple shards",
    );
    expect(output.stderr).toContain("--parallel is supported");
    expect(output.stdout).toBe("");
    expect(createRelevanceProvider).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  },
);

it("stops on invalid discovery, invalid modules, and provider errors without exposing raw errors", async () => {
  await fixture();
  await write("app.ts", "changed\n");
  commit();
  const executeRun = vi.fn();
  const scoreRelevance = vi.fn(async () => {
    throw new Error("secret raw provider response");
  });
  const runtime = {
    cwd: root,
    executeRun,
    createRelevanceProvider: () => ({ scoreRelevance }),
  };
  const failed = await runCli(["run", "--affected"], "test", runtime);
  expect(failed.exitCode).toBe(3);
  expect(failed.stderr).not.toContain("secret");
  await write("tests/login.module.yaml", "steps: []\n");
  commit();
  scoreRelevance.mockClear();
  expect((await runCli(["run", "--affected"], "test", runtime)).exitCode).toBe(
    3,
  );
  expect(scoreRelevance).not.toHaveBeenCalled();
  await write("tests/profile.test.yaml", "not: a test\n");
  commit();
  expect((await runCli(["run", "--affected"], "test", runtime)).exitCode).toBe(
    3,
  );
  expect(executeRun).not.toHaveBeenCalled();
});

it.each([
  ["--threshold", "NaN"],
  ["--threshold", "1.1"],
  ["--threshold", "-0.1"],
  ["--threshold", "0.2"],
  ["--selection-only"],
  ["--base", "main"],
  ["--affected-ignore", "docs/"],
  ["--affected", "--affected-ignore", "[broken"],
])("rejects invalid or orphan selection flags %j", async (...flags) => {
  const executeRun = vi.fn();
  expect(
    (await runCli(["run", ...flags], "test", { executeRun })).exitCode,
  ).toBe(3);
  expect(executeRun).not.toHaveBeenCalled();
});

it.each([false, true])(
  "refuses tracked local secrets before provider creation even when ignored (staged=%s)",
  async (staged) => {
    await fixture();
    await write(".env", "PUBLIC_VALUE=base\n");
    commit();
    git("branch", "-f", "main", "HEAD");
    await write(".env", "PUBLIC_VALUE=local-secret-marker\n");
    if (staged) git("add", ".env");
    const createRelevanceProvider = vi.fn();
    const executeRun = vi.fn();
    const result = await runCli(
      ["run", "--affected", "--affected-ignore", ".env"],
      "test",
      { cwd: root, createRelevanceProvider, executeRun },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Commit or stash");
    expect(result.stderr).not.toContain("local-secret-marker");
    expect(createRelevanceProvider).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  },
);

it.each([
  ["--assume-unchanged", false],
  ["--assume-unchanged", true],
  ["--skip-worktree", false],
  ["--skip-worktree", true],
] as const)(
  "refuses index flag %s even on ignored paths (dirty=%s)",
  async (flag, dirty) => {
    await fixture();
    await write("app.ts", "export const cartTotal = 20;\n");
    await write("other.ts", "export const other = 1;\n");
    commit();
    git("update-index", flag, "app.ts");
    if (dirty) await write("app.ts", "local-secret-marker\n");
    expect(git("status", "--porcelain=v1", "--untracked-files=no")).toBe("");
    const flags = git("ls-files", "-v", "--", "app.ts");
    const createRelevanceProvider = vi.fn();
    const executeRun = vi.fn();
    const result = await runCli(
      ["run", "--affected", "--affected-ignore", "app.ts"],
      "test",
      { cwd: root, createRelevanceProvider, executeRun },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("assume-unchanged or skip-worktree");
    expect(result.stderr).not.toContain("local-secret-marker");
    expect(createRelevanceProvider).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
    expect(git("ls-files", "-v", "--", "app.ts")).toBe(flags);
  },
);

it("combines config and CLI ignores before patch reading while forcing changed ignored modules", async () => {
  await fixture();
  await write(
    "sedum.config.yaml",
    "affected:\n  ignore: [sedum.config.yaml, binary.dat, docs/, '*.lock']\n",
  );
  await mkdir(path.join(root, "docs"));
  await write("docs/spec.md", "spec\n".repeat(495));
  await write("binary.dat", "\0unscorable");
  await write("root.lock", "lock\n");
  await write(
    "tests/login.module.yaml",
    "parameters: []\nsteps: [click login]\n",
  );
  commit();
  const createRelevanceProvider = vi.fn();
  const preview = await runCli(
    ["run", "--affected", "--selection-only", "--affected-ignore", "tests/"],
    "test",
    { cwd: root, createRelevanceProvider },
  );
  expect(preview.exitCode, preview.stderr).toBe(0);
  const selection = JSON.parse(preview.stdout);
  expect(selection.ignoredFiles).toEqual([
    "binary.dat",
    "docs/spec.md",
    "root.lock",
    "sedum.config.yaml",
    "tests/login.module.yaml",
  ]);
  expect(selection).toMatchObject({ aggregation: "max", chunkCount: 0 });
  expect(selection.tests).toEqual([
    {
      file: "tests/cart.test.yaml",
      probability: 1,
      selected: true,
      reason: "test-or-module-changed",
    },
    {
      file: "tests/profile.test.yaml",
      probability: 0,
      selected: false,
      reason: "all-ignored",
    },
  ]);
  expect(createRelevanceProvider).not.toHaveBeenCalled();
});

it("handles literal strange filenames, deleted paths, ignored untracked paths and invalid ignores", async () => {
  await fixture();
  const names = [
    "-leading.ts",
    "[pattern].ts",
    "space name.ts",
    // Windows rejects control characters in filenames; retain the other cases there.
    ...(process.platform === "win32" ? [] : ["line\nbreak.ts"]),
  ];
  for (const [i, name] of names.entries()) await write(name, `unique-${i}\n`);
  await rm(path.join(root, "app.ts"));
  commit();
  await write("notes.tmp", "unrelated untracked\n");
  const diff = await readBranchDiff(
    path.join(root, "tests"),
    undefined,
    undefined,
    ["notes.tmp", "[[]pattern].ts"],
  );
  expect(diff.changed).toEqual(expect.arrayContaining([...names, "app.ts"]));
  expect(diff.diff).toContain("-export const cartTotal = 10;");
  expect(diff.diff).toContain("+unique-0");
  expect(diff.diff).toContain("+unique-2");
  await expect(
    readBranchDiff(root, undefined, undefined, ["../outside"]),
  ).rejects.toThrow("POSIX globs");
});

it("streams retained patches above 2 MiB and refuses the total 16 MiB ceiling", async () => {
  await fixture();
  for (const name of ["a.ts", "b.ts", "c.ts"])
    await write(name, "line\n".repeat(160_000));
  commit();
  const diff = await readBranchDiff(root);
  expect(Buffer.byteLength(diff.diff)).toBeGreaterThan(2 * 1024 * 1024);
  expect(diff.diff).toContain("b/c.ts");
  await write("huge.ts", "x\n".repeat(6_000_000));
  commit();
  await expect(readBranchDiff(root)).rejects.toThrow("16 MiB guard");
}, 20_000);

it("keeps a sanitized 79-test/14-file umbrella suite and large excluded fixtures selectable", async () => {
  await fixture();
  for (let i = 0; i < 10; i++)
    await write(
      `tests/flow-${i}.test.yaml`,
      `id: flow-${i}\nsteps: [verify flow ${i}]\n`,
    );
  for (const [name, count] of [
    ["wealth", 34],
    ["onboarding", 33],
  ] as const) {
    const body = Array.from(
      { length: count },
      (_, i) => `test("${name}-${i}", async () => {});`,
    ).join("\n");
    await write(
      `tests/${name}.test.ts`,
      `import { test } from "sedum-cli";\n${body}\n/*${"x".repeat(15_500 - body.length - 39)}*/\n`,
    );
  }
  commit();
  git("branch", "-f", "main", "HEAD");
  await mkdir(path.join(root, "fixtures"));
  await write(
    "fixtures/seed.json",
    JSON.stringify({ data: "x".repeat(471_000) }),
  );
  for (let i = 0; i < 46; i++)
    await write(
      `ui-${i}.elm`,
      `module Ui${i} exposing (value)\nvalue = ${i}\n`,
    );
  commit();
  const inventory = await discoverRunTests(await loadProjectConfig(root), []);
  expect(inventory.tests).toHaveLength(79);
  const scoreRelevance = vi.fn(
    async (_diff: string, tests: readonly { file: string }[]) => ({
      probabilities: tests.map((item) =>
        item.file.includes("wealth") ? 0.77 : 0.12,
      ),
      calls: [],
      chunkCount: 1,
    }),
  );
  const selection = await selectAffectedTests({
    cwd: root,
    paths: [],
    filters: {},
    threshold: 0.4,
    ignore: ["fixtures/"],
    createProvider: () => ({ scoreRelevance }),
  });
  expect(selection.tests).toHaveLength(14);
  expect(
    selection.tests.filter((item) => item.selected).map((item) => item.file),
  ).toEqual(["tests/wealth.test.ts"]);
  expect(scoreRelevance.mock.calls[0]![0]).not.toContain("seed.json");
  expect(scoreRelevance.mock.calls[0]![0]).toContain("ui-45.elm");
});

it("validates pinned sources, changing HEAD and cancellation without returning partial data", async () => {
  await fixture();
  const head = git("rev-parse", "HEAD");
  const snapshot = { root, head };
  expect(await readCommittedSource(snapshot, path.join(root, "app.ts"))).toBe(
    "export const cartTotal = 10;\n",
  );
  await expect(
    readCommittedSource(snapshot, path.join(root, "missing")),
  ).rejects.toThrow("pinned HEAD");
  await expect(
    readCommittedSource(snapshot, path.join(root, "../outside")),
  ).rejects.toThrow("outside");
  await write("app.ts", "committed change\n");
  commit();
  await expect(assertAffectedSnapshot(snapshot)).rejects.toThrow(
    "HEAD changed",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(
    readBranchDiff(root, undefined, controller.signal),
  ).rejects.toThrow();
});

it("reports missing ancestry and non-UTF8 text without transmitting partial patches", async () => {
  await fixture();
  git("branch", "-D", "main");
  await expect(readBranchDiff(root)).rejects.toThrow("No main or master");
  await writeFile(
    path.join(root, "invalid.txt"),
    Buffer.from([0x61, 0xff, 0x0a]),
  );
  commit();
  await expect(readBranchDiff(root, "HEAD~1")).rejects.toThrow("valid UTF-8");
});

it("executes nothing at threshold zero for no diff or all ignored and maps forced scores independently", async () => {
  await fixture();
  const createProvider = vi.fn(() => ({
    scoreRelevance: async () => ({ probabilities: [0.2], calls: [] }),
  }));
  const options = {
    cwd: root,
    paths: [],
    filters: {},
    threshold: 0,
    createProvider,
  };
  expect(
    (await selectAffectedTests(options)).tests.every((test) => !test.selected),
  ).toBe(true);
  await write("app.ts", "changed\n");
  commit();
  const ignored = await selectAffectedTests({ ...options, ignore: ["app.ts"] });
  expect(
    ignored.tests.every(
      (test) => !test.selected && test.reason === "all-ignored",
    ),
  ).toBe(true);
  expect(createProvider).not.toHaveBeenCalled();
  await write(
    "tests/profile.test.yaml",
    "id: profile\nsteps: [verify changed profile]\n",
  );
  commit();
  const mapped = await selectAffectedTests({ ...options, threshold: 0.3 });
  expect(mapped.tests.map((test) => [test.probability, test.selected])).toEqual(
    [
      [0.2, false],
      [1, true],
    ],
  );
  const filtered = await selectAffectedTests({
    ...options,
    filters: { include: ["tests/profile.test.yaml"] },
    threshold: 1,
    ignore: ["tests/", "app.ts"],
  });
  expect(filtered.tests).toHaveLength(1);
  expect(filtered.tests[0]!.selected).toBe(true);
});

it("pins a merged PR's committed range without mutating Git history", async () => {
  await fixture();
  await write("app.ts", "feature behavior\n");
  commit();
  git("checkout", "main");
  await write("base-only.ts", "base-only\n");
  commit();
  const base = git("rev-parse", "HEAD");
  git("checkout", "feature");
  git("merge", "--no-edit", "main");
  const head = git("rev-parse", "HEAD");
  const diff = await readBranchDiff(root);
  expect(diff.mergeBase).toBe(base);
  expect(diff.changed).toEqual(["app.ts"]);
  expect(diff.diff).toContain("+feature behavior");
  expect(git("rev-parse", "HEAD")).toBe(head);
  expect(git("status", "--porcelain")).toBe("");
});

it.skipIf(process.env.SEDUM_TYPESAFE_LIVE !== "1")(
  "live Jev smoke evaluation: cart, profile, and documentation diffs",
  async () => {
    await fixture();
    await write("profile.ts", 'export const profileName = "Alice";\n');
    await write("README.md", "# Example shop\n");
    git("add", ".");
    git("commit", "-m", "evaluation baseline");
    git("branch", "-f", "main", "HEAD");
    const cases = [
      {
        file: "app.ts",
        source: "export const cartTotal = 99;\n",
        expected: [true, false],
      },
      {
        file: "profile.ts",
        source: 'export const profileName = "Bob";\n',
        expected: [false, true],
      },
      {
        file: "README.md",
        source: "# Example shop\nFix a documentation typo.\n",
        expected: [false, false],
      },
    ];
    for (const scenario of cases) {
      const baseline = git("rev-parse", "main");
      await write(scenario.file, scenario.source);
      commit();
      const output = await runCli(
        ["run", "--affected", "--selection-only"],
        "test",
        { cwd: root },
      );
      expect(output.exitCode, output.stderr).toBe(0);
      const selection = JSON.parse(output.stdout);
      process.stdout.write(
        `${JSON.stringify({ scenario: scenario.file, tests: selection.tests, calls: selection.calls })}\n`,
      );
      // Record every scenario even when the model misses the ideal selection.
      expect
        .soft(
          selection.tests.map((test: { selected: boolean }) => test.selected),
        )
        .toEqual(scenario.expected);
      git("reset", "--hard", baseline);
    }
  },
  120_000,
);
