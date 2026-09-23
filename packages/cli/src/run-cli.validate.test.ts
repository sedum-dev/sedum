import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MODEL_CHOICES, ProviderError } from "@sedum-dev/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-cli-project-"));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  }
  return root;
}

const VALID = {
  "valid/login.test.yaml":
    "id: login\ndescription: a customer signs in\ntags: [smoke, auth]\nurl: https://example.test/login\ndata:\n  user: alice\n  password: $SEDUM_TEST_UNSET_VARIABLE\nsteps:\n  - type {{user}} in the username field\n  - type {{password}} in the password field\n  - click the login button\n",
  "valid/cart.test.yaml":
    "url: https://example.test/cart\nsteps:\n  - click the cart link\n",
};
const BROKEN = {
  ...VALID,
  "broken/typo.test.yaml":
    "url: https://example.test\nsteps:\n  - click the button\nstepz: []\n",
  "broken/unclear.test.yaml":
    "url: https://example.test\nsteps:\n  - add the cheapest item to the basket\n",
  "broken/uses-missing.test.yaml":
    "url: https://example.test\nsteps:\n  - use: ./missing.module.yaml\n",
  "broken/bad.test.yaml": "steps:\n  - click a\n  bad: [\n",
  "modules/orphan.module.yaml":
    "parameters: []\nsteps:\n  - do the checkout dance\n",
};

const plain = { stdoutIsTTY: false, stderrIsTTY: false, color: false };
const noProvider = () => {
  throw new Error("offline commands must not create a provider");
};

describe("sedum validate", () => {
  it("prints every problem with a fix and exits 1 on a deliberately broken project", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["validate"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toBe("");
    expect(output.stdout).toContain(
      "broken/typo.test.yaml:4:1: error unknown_key: Unknown top-level key `stepz`.\n  Fix: Did you mean `steps`?\n",
    );
    expect(output.stdout).toContain(
      'broken/unclear.test.yaml:3:5: not checked offline: Classification is unavailable offline for this sentence (cache: absent). Sentence: "add the cheapest item to the basket".\n  Fix: Rephrase with a supported verb, or run `sedum validate --online` with TYPESAFE_API_KEY set and commit .sedum/classifications.json.\n',
    );
    expect(output.stdout).toContain(
      "broken/uses-missing.test.yaml:3:5: error unreadable_module:",
    );
    expect(output.stdout).toContain(
      "broken/bad.test.yaml:3:1: error yaml_syntax:",
    );
    expect(output.stdout).toContain(
      "modules/orphan.module.yaml:3:5: not checked offline:",
    );
    expect(output.stdout).toContain(
      "Checked 6 tests and 1 module: 4 errors, 2 sentences not checked offline.\n1 module not used by any test was checked for format and its own sentences only; module calls are checked through tests.\n",
    );
    expect(output.stdout).not.toContain("\u001b[");
  });

  it("exits 0 for a valid subset with an unset environment variable", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["validate", "valid"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(output).toEqual({
      stdout: "Checked 2 tests and 0 modules: all valid.\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("colors labels only when the terminal allows color", async () => {
    const cwd = await project(BROKEN);
    const colored = await runCli(
      ["validate", "broken/typo.test.yaml"],
      "0.0.0",
      {
        cwd,
        capabilities: { stdoutIsTTY: true, stderrIsTTY: true, color: true },
        createClassificationProvider: noProvider,
      },
    );
    expect(colored.stdout).toContain("\u001b[31merror unknown_key\u001b[0m");
    const valid = await runCli(["validate", "valid"], "0.0.0", {
      cwd,
      capabilities: { stdoutIsTTY: true, stderrIsTTY: true, color: true },
      createClassificationProvider: noProvider,
    });
    expect(valid.stdout).toContain("\u001b[32mall valid\u001b[0m");
    const noColor = await runCli(
      ["validate", "broken/typo.test.yaml"],
      "0.0.0",
      {
        cwd,
        capabilities: { stdoutIsTTY: true, stderrIsTTY: true, color: false },
        createClassificationProvider: noProvider,
      },
    );
    expect(noColor.stdout).not.toContain("\u001b[");
  });

  it.each([
    [["validate", "absent"], "absent does not exist."],
    [
      ["validate", "notes.txt"],
      "notes.txt is not a *.test.yaml or *.module.yaml file.",
    ],
    [
      ["validate", "empty"],
      "No *.test.yaml or *.module.yaml files were found under empty.",
    ],
    [["validate", ".."], "is outside the project root"],
  ])("exits 3 for usage problem %j", async (args, message) => {
    const cwd = await project({
      ...BROKEN,
      "notes.txt": "x",
      "empty/.keep": "",
    });
    const output = await runCli(args, "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(output.exitCode).toBe(3);
    expect(output.stdout).toBe("");
    expect(output.stderr).toContain(message);
    expect(output.stderr).toContain("Fix: ");
  });

  it("gives a usage problem precedence over findings in other paths", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["validate", "broken", "absent"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(output.exitCode).toBe(3);
  });

  it("exits 3 when --online has no configured provider key", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["validate", "--online"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: () => {
        throw new ProviderError("configuration", "missing key");
      },
    });
    expect(output.exitCode).toBe(3);
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe(
      "`sedum validate --online` needs a configured TypeSafe provider.\nFix: Set TYPESAFE_API_KEY and rerun, or omit --online to validate offline.\n",
    );
    const broken = await runCli(["validate", "--online"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: () => {
        throw new Error("package missing");
      },
    });
    expect(broken.exitCode).toBe(3);
    expect(broken.stderr).toContain("could not be prepared");
  });

  it("uses the real TypeSafe factory for --online and exits 3 without a key", async () => {
    const cwd = await project(VALID);
    vi.stubEnv("TYPESAFE_API_KEY", "");
    try {
      const output = await runCli(["validate", "--online"], "0.0.0", {
        cwd,
        capabilities: plain,
      });
      expect(output.exitCode).toBe(3);
      expect(output.stderr).toContain("Set TYPESAFE_API_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps exit 0 when only warnings are found", async () => {
    const cwd = await project({
      "t.test.yaml":
        "url: https://example.test\ndata:\n  postcode: 01234\nsteps:\n  - click the cart link\n",
    });
    const output = await runCli(["validate"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(output.stdout).toContain("t.test.yaml:3:13: warning ");
    expect(output.stdout).toContain("Checked 1 test and 0 modules: 1 warning.");
    expect(output.exitCode).toBe(0);
  });

  it("exits 3 when the online provider fails, even with other findings", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["validate", "--online"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: () => ({
        async classifyBatch() {
          throw new ProviderError("connection", "offline");
        },
      }),
    });
    expect(output.exitCode).toBe(3);
    expect(output.stdout).toContain("error provider_error");
  });

  it("populates the cache online so the next offline validation passes", async () => {
    const cwd = await project({
      "t.test.yaml":
        "url: https://example.test\nsteps:\n  - tidy up the shopping list\n",
    });
    const offline = await runCli(["validate"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(offline.exitCode).toBe(1);
    const probabilities = Object.fromEntries(
      MODEL_CHOICES.map((choice) => [
        choice,
        choice === "click" ? 0.95 : 0.005,
      ]),
    ) as Record<(typeof MODEL_CHOICES)[number], number>;
    const classifyBatch = vi.fn(async () => ({
      answers: [
        {
          op: "click" as const,
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
    }));
    const online = await runCli(["validate", "--online"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: () => ({ classifyBatch }),
    });
    expect(online).toMatchObject({ exitCode: 0 });
    expect(classifyBatch).toHaveBeenCalledTimes(1);
    const again = await runCli(["validate"], "0.0.0", {
      cwd,
      capabilities: plain,
      createClassificationProvider: noProvider,
    });
    expect(again.exitCode).toBe(0);
  });
});

describe("sedum list", () => {
  it("lists valid tests, names invalid files on stderr, and exits 1", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["list"], "0.0.0", {
      cwd,
      capabilities: plain,
    });
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe(
      [
        "ID                             TAGS        PATH",
        "broken/unclear.test.yaml       -           broken/unclear.test.yaml",
        "broken/uses-missing.test.yaml  -           broken/uses-missing.test.yaml",
        "valid/cart.test.yaml           -           valid/cart.test.yaml",
        "login                          smoke,auth  valid/login.test.yaml",
        "4 tests",
        "",
      ].join("\n"),
    );
    expect(output.stderr).toContain(
      "broken/typo.test.yaml:4:1: error unknown_key: Unknown top-level key `stepz`.\nRun `sedum validate broken/typo.test.yaml` for all problems.\n",
    );
    expect(output.stderr).toContain(
      "broken/bad.test.yaml:3:1: error yaml_syntax:",
    );
  });

  it("prints only versioned JSON on stdout without data, url, or meta values", async () => {
    const cwd = await project(BROKEN);
    const output = await runCli(["list", "--json"], "0.0.0", {
      cwd,
      capabilities: plain,
    });
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toBe("");
    const listing = JSON.parse(output.stdout) as {
      schemaVersion: number;
      tests: unknown[];
      invalid: { file: string; diagnostics: { code: string }[] }[];
    };
    expect(listing.schemaVersion).toBe(1);
    expect(listing.tests).toContainEqual({
      id: "login",
      idSource: "explicit",
      file: "valid/login.test.yaml",
      description: "a customer signs in",
      tags: ["smoke", "auth"],
    });
    expect(listing.invalid.map((entry) => entry.file)).toEqual([
      "broken/bad.test.yaml",
      "broken/typo.test.yaml",
    ]);
    expect(Object.keys(listing.invalid[1]!.diagnostics[0]!)).toEqual([
      "severity",
      "code",
      "line",
      "col",
      "message",
      "fix",
    ]);
    expect(output.stdout).not.toMatch(/alice|SEDUM_TEST_UNSET|example\.test/);
  });

  it("exits 0 with no tests and 3 for a missing path", async () => {
    const cwd = await project({ "empty/.keep": "" });
    expect(
      await runCli(["list", "empty"], "0.0.0", { cwd, capabilities: plain }),
    ).toEqual({ stdout: "No tests found.\n", stderr: "", exitCode: 0 });
    const json = await runCli(["list", "empty", "--json"], "0.0.0", {
      cwd,
      capabilities: plain,
    });
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      tests: [],
      invalid: [],
    });
    const missing = await runCli(["list", "absent"], "0.0.0", {
      cwd,
      capabilities: plain,
    });
    expect(missing.exitCode).toBe(3);
    expect(missing.stderr).toContain("absent does not exist.");
  });

  it("documents both commands in root help", async () => {
    const output = await runCli(["--help"], "0.0.0");
    expect(output.stdout).toContain("validate");
    expect(output.stdout).toContain("list");
    expect(output.stdout).toContain("sedum validate");
  });
});
