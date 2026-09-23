import { RunRecorder, type ResultStep, type RunResult } from "@sedum-dev/core";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "./run-cli.js";

function step(
  id: string,
  verdict: "passed" | "failed",
  flags: ResultStep["flags"] = [],
): ResultStep {
  return {
    id,
    index: 1,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence: "verify the result",
    detail: "",
    sourceStack: [{ file: `${id}.test.yaml`, line: 3, col: 5 }],
    state: "completed",
    verdict,
    flags,
    elapsedMs: 1,
    page: { status: "unavailable", reason: "fixture" },
    locator: null,
    judgement: null,
    observations: [],
    calls: [],
    error: null,
    evidence: { status: "omitted", reason: "fixture" },
    replayFrame: null,
    targetBox: null,
  };
}

async function result(
  tests: readonly {
    file: string;
    verdict: "passed" | "failed";
    flags?: ResultStep["flags"];
  }[],
  operational = false,
  incompleteCost = false,
): Promise<RunResult> {
  const recorder = new RunRecorder(async () => undefined, "cli-fixture");
  await recorder.start();
  if (incompleteCost)
    await recorder.addSetupCalls([
      {
        purpose: "classification",
        requestedModel: "jev-latest",
        model: "unknown",
        attempts: 1,
        inputTokens: 0,
        outputTokens: 0,
        apiMs: null,
        inputUsdPerMillion: null,
        outputUsdPerMillion: null,
        rateSource: null,
        rateCheckedAt: null,
        costUsd: null,
      },
    ]);
  for (const [index, test] of tests.entries()) {
    await recorder.startTest({ id: `test-${index}`, file: test.file });
    await recorder.addStep(
      step(`step-${index}`, test.verdict, test.flags ?? []),
    );
    await recorder.finishTest(test.verdict);
  }
  if (operational) {
    await recorder.startTest({ id: "partial", file: "partial.test.yaml" });
    await recorder.finish({
      code: "execution_error",
      message: "The browser disconnected.",
    });
  } else await recorder.finish();
  return recorder.snapshot;
}

function execution(value: RunResult) {
  return {
    result: value,
    artifacts: {
      progressPath: "/repo/.sedum/runs/fixture/progress.json",
      resultPath: "/repo/.sedum/runs/fixture/result.json",
      authoritative: true,
    },
    diagnostic: value.error
      ? {
          code: value.error.code,
          message: value.error.message,
          fix: "Install the browser and rerun.",
        }
      : null,
  };
}

describe("CLI command framework", () => {
  it("prints useful root, run, and nested command help", async () => {
    const root = await runCli(["--help"], "1.2.3");
    expect(root.exitCode).toBe(0);
    expect(root.stdout).toContain("sedum run");
    expect(root.stdout).toContain("sedum browsers");
    expect(root.stdout).toContain("2 flagged pass with --strict");
    const run = await runCli(["run", "--help"], "1.2.3");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("--strict");
    expect(run.stdout).toContain("TYPESAFE_API_KEY");
    const install = await runCli(["browsers", "install", "--help"], "1.2.3");
    expect(install.exitCode).toBe(0);
    expect(install.stdout).toContain("--with-deps");
  });

  it("prints the supplied package version through both flags", async () => {
    expect(await runCli(["--version"], "1.2.3")).toMatchObject({
      stdout: "1.2.3\n",
      stderr: "",
      exitCode: 0,
    });
    expect((await runCli(["-v"], "1.2.3")).exitCode).toBe(0);
  });

  it("routes and validates browser installation", async () => {
    const install = vi.fn(() => ({
      exitCode: 0,
      stdout: "installed\n",
      stderr: "",
    }));
    expect(
      await runCli(
        ["browsers", "install", "chromium", "--with-deps"],
        "1.2.3",
        { installChromium: install },
      ),
    ).toEqual({ stdout: "installed\n", stderr: "", exitCode: 0 });
    expect(install).toHaveBeenCalledWith(true);
    const failedInstall = await runCli(
      ["browsers", "install", "chromium"],
      "1.2.3",
      {
        installChromium: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "installer failed\n",
        }),
      },
    );
    expect(failedInstall).toMatchObject({ exitCode: 3 });
    expect(failedInstall.stderr).toContain("resolve the installer error");
    const unsupported = await runCli(
      ["browsers", "install", "firefox"],
      "1.2.3",
    );
    expect(unsupported.exitCode).toBe(3);
    expect(unsupported.stderr).toContain(
      "use `sedum browsers install chromium`",
    );
  });

  it("makes every malformed invocation actionable and operational", async () => {
    for (const args of [[], ["--unknown"], ["browsers"]]) {
      const output = await runCli(args, "1.2.3");
      expect(output.exitCode).toBe(3);
      expect(output.stderr).toContain("Fix:");
      expect(`${output.stdout}${output.stderr}`).toContain("help");
    }
    const invalid = await runCli(
      ["run", "x.test.yaml", "--sensitive-origin", "not a URL"],
      "1.2.3",
    );
    expect(invalid.exitCode).toBe(3);
    expect(invalid.stderr).toContain("absolute URL");
  });

  it("allows a config-driven run without a positional file", async () => {
    const canonical = await result([
      { file: "configured.test.yaml", verdict: "passed" },
    ]);
    const executeRun = vi.fn(async () => execution(canonical));
    const output = await runCli(["run"], "1.2.3", { executeRun });
    expect(output.exitCode).toBe(0);
    expect(executeRun).toHaveBeenCalledWith(
      expect.not.objectContaining({ file: expect.anything() }),
    );
  });

  it("passes normalized flags to the run command", async () => {
    const canonical = await result([
      { file: "x.test.yaml", verdict: "passed" },
    ]);
    const executeRun = vi.fn(async () => execution(canonical));
    await runCli(
      [
        "run",
        "x.test.yaml",
        "--replay",
        "--no-evidence",
        "--no-locator-cache",
        "--locator-cache-ci",
        "--sensitive-origin=https://example.com/private",
        "--sensitive-origin",
        "https://two.test/path",
      ],
      "1.2.3",
      { executeRun },
    );
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        file: "x.test.yaml",
        replay: true,
        evidence: false,
        locatorCacheDisabled: true,
        locatorCacheCi: true,
        sensitiveOrigins: ["https://example.com", "https://two.test"],
      }),
    );
  });

  it("applies the SED-13 matrix through the full command tree", async () => {
    const cases = [
      {
        value: await result([{ file: "clean.test.yaml", verdict: "passed" }]),
        exits: [0, 0],
      },
      {
        value: await result([
          {
            file: "flagged.test.yaml",
            verdict: "passed",
            flags: ["low_confidence"],
          },
        ]),
        exits: [0, 2],
      },
      {
        value: await result([{ file: "failed.test.yaml", verdict: "failed" }]),
        exits: [1, 1],
      },
      {
        value: await result([
          { file: "failed.test.yaml", verdict: "failed" },
          {
            file: "flagged.test.yaml",
            verdict: "passed",
            flags: ["contradiction"],
          },
        ]),
        exits: [1, 1],
      },
      {
        value: await result(
          [{ file: "completed.test.yaml", verdict: "passed" }],
          true,
        ),
        exits: [3, 3],
      },
    ];
    for (const scenario of cases) {
      const before = structuredClone(scenario.value);
      for (const [strict, expected] of [
        [false, scenario.exits[0]],
        [true, scenario.exits[1]],
      ] as const) {
        const output = await runCli(
          ["run", "fixture.test.yaml", ...(strict ? ["--strict"] : [])],
          "1.2.3",
          { executeRun: async () => execution(scenario.value) },
        );
        expect(output.exitCode).toBe(expected);
      }
      expect(scenario.value).toEqual(before);
    }
  });

  it("colors persistent test rows in TTY and keeps redirected output plain", async () => {
    const canonical = await result(
      [
        { file: "a-very-long-clean-name.test.yaml", verdict: "passed" },
        {
          file: "flagged.test.yaml",
          verdict: "passed",
          flags: ["low_confidence", "contradiction"],
        },
        {
          file: "failed.test.yaml",
          verdict: "failed",
          flags: ["low_confidence"],
        },
      ],
      true,
    );
    const tty = await runCli(["run", "fixture.test.yaml"], "1.2.3", {
      capabilities: { stdoutIsTTY: true, stderrIsTTY: true, color: true },
      executeRun: async (options) => {
        options.onSnapshot?.(canonical);
        return execution(canonical);
      },
    });
    const plain = await runCli(["run", "fixture.test.yaml"], "1.2.3", {
      capabilities: { stdoutIsTTY: false, stderrIsTTY: false, color: false },
      executeRun: async () => execution(canonical),
    });
    expect(tty.stdout).toContain("\u001b[32mPASSED\u001b[0m");
    expect(tty.stdout).toContain("\u001b[31mFAILED\u001b[0m");
    expect(tty.stdout).toContain("\u001b[31mERROR\u001b[0m");
    expect(plain.stdout).not.toContain("\u001b");
    expect(plain.stdout).not.toContain("\r");
    expect(plain.stdout).not.toContain("…");
    expect(plain.stdout).toContain("a-very-long-clean-name.test.yaml");
    expect(plain.stdout).toContain(
      "flags 2 flagged step(s), low_confidence 2, contradiction 1",
    );
    const ansiPattern = new RegExp(
      `${String.fromCharCode(27)}\\[[0-9;]*m`,
      "gu",
    );
    const finalTty = tty.stdout
      .replaceAll("\r\u001b[2K", "")
      .replace(ansiPattern, "");
    expect(finalTty).toContain(plain.stdout);
  });

  it("shows costs by default only for a TTY", async () => {
    const canonical = await result([
      { file: "x.test.yaml", verdict: "passed" },
    ]);
    const plain = await runCli(["run", "x.test.yaml"], "1.2.3", {
      executeRun: async () => execution(canonical),
    });
    expect(plain.stdout).not.toContain("model 0 call");
    const requested = await runCli(["run", "x.test.yaml", "--costs"], "1.2.3", {
      executeRun: async () => execution(canonical),
    });
    expect(requested.stdout).toContain("model 0 call(s)");
    const tty = await runCli(["run", "x.test.yaml"], "1.2.3", {
      capabilities: { stdoutIsTTY: true, stderrIsTTY: true, color: false },
      executeRun: async () => execution(canonical),
    });
    expect(tty.stdout).toContain("cost $0.000000");

    const incomplete = await result(
      [{ file: "x.test.yaml", verdict: "passed" }],
      false,
      true,
    );
    const incompleteOutput = await runCli(
      ["run", "x.test.yaml", "--costs"],
      "1.2.3",
      { executeRun: async () => execution(incomplete) },
    );
    expect(incompleteOutput.stdout).toContain("cost unknown or incomplete");
  });

  it("does not advertise a non-authoritative result path", async () => {
    const canonical = await result([
      { file: "x.test.yaml", verdict: "passed" },
    ]);
    const output = await runCli(["run", "x.test.yaml"], "1.2.3", {
      executeRun: async () => ({
        ...execution(canonical),
        artifacts: {
          progressPath: "/intended/progress.json",
          resultPath: "/intended/result.json",
          authoritative: false,
        },
      }),
    });
    expect(output.stdout).toContain(
      "result unavailable (intended /intended/result.json)",
    );
    expect(output.stdout).not.toContain("progress /intended/progress.json");
  });
});
