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
import { RunRecorder } from "@sedum-dev/core";
import { readBranchDiff, selectAffectedTests } from "./affected-selection.js";
import { runCli } from "./run-cli.js";

let root: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (file: string, source: string) =>
  writeFile(path.join(root, file), source);
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
  if (root) await rm(root, { recursive: true, force: true });
});

it("uses the merge base, excludes base-only changes, and includes committed, staged and unstaged changes from a subdirectory", async () => {
  await fixture();
  const ancestor = git("rev-parse", "HEAD");
  git("checkout", "main");
  await write("base-only.ts", "unrelated main work\n");
  git("add", ".");
  git("commit", "-m", "advance main");
  git("checkout", "feature");
  await write("app.ts", "export const cartTotal = 20;\n");
  git("commit", "-am", "feature change");
  await write("staged.ts", "staged code\n");
  git("add", "staged.ts");
  await write("app.ts", "export const cartTotal = 30;\n");
  git("config", "diff.relative", "true");
  const diff = await readBranchDiff(path.join(root, "tests"));
  expect(diff.mergeBase).toBe(ancestor);
  expect(diff.changed).toEqual(["app.ts", "staged.ts"]);
  expect(diff.diff).toContain("+export const cartTotal = 30;");
  expect(diff.diff).toContain("+staged code");
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
});

it("refuses binary and submodule changes rather than scoring incomplete text", async () => {
  await fixture();
  await write("binary.dat", "\0binary");
  git("add", "binary.dat");
  await expect(readBranchDiff(root)).rejects.toThrow("Binary or submodule");
  git("reset", "--", "binary.dat");
  await rm(path.join(root, "binary.dat"));
  git("clone", "--shared", root, "vendor");
  git(
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git("rev-parse", "HEAD")},vendor`,
  );
  await expect(readBranchDiff(root)).rejects.toThrow("Binary or submodule");
});

it("includes complete test and module source, selects the exact threshold, and skips below it", async () => {
  await fixture();
  await write("app.ts", "export const cartTotal = 99;\n");
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
  expect(scored).toEqual([
    "tests/cart.test.yaml",
    "tests/profile.test.yaml",
    "tests/shop.test.ts",
  ]);
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
      probability: 0,
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
  const createProvider = vi.fn(() => ({
    scoreRelevance: async () => ({ probabilities: [0, 0], calls: [] }),
  }));
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("CLOUDFLARE_AUTH_TOKEN", "");
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
  const output = await runCli(["run", "--affected"], "test", runtime);
  expect(output.exitCode).toBe(0);
  expect(output.stderr).toContain("No relevant tests selected");
  expect(executeRun).not.toHaveBeenCalled();
});

it("previews JSON, passes only selected paths to the runner, and preserves failure exit codes", async () => {
  await fixture();
  await write("app.ts", "changed\n");
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
      scoreRelevance: async () => ({ probabilities: [0.7, 0], calls: [] }),
    }),
  };
  const preview = await runCli(
    ["run", "--affected", "--selection-only"],
    "test",
    runtime,
  );
  expect(preview.exitCode).toBe(0);
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
  scoreRelevance.mockClear();
  expect((await runCli(["run", "--affected"], "test", runtime)).exitCode).toBe(
    3,
  );
  expect(scoreRelevance).not.toHaveBeenCalled();
  await write("tests/profile.test.yaml", "not: a test\n");
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
])("rejects invalid or orphan selection flags %j", async (...flags) => {
  const executeRun = vi.fn();
  expect(
    (await runCli(["run", ...flags], "test", { executeRun })).exitCode,
  ).toBe(3);
  expect(executeRun).not.toHaveBeenCalled();
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
      const original = await readFile(path.join(root, scenario.file), "utf8");
      await write(scenario.file, scenario.source);
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
      await write(scenario.file, original);
    }
  },
  120_000,
);
