import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFlow, validateRunResult, type ResultStep } from "@sedum-dev/core";

vi.mock("@sedum-dev/provider-typesafe", () => ({
  TypeSafeAdapter: class {},
}));

vi.mock("@sedum-dev/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sedum-dev/core")>();
  const fixtureStep: ResultStep = {
    id: "step",
    index: 1,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence: "verify",
    detail: "",
    sourceStack: [{ file: "fixture.test.yaml", line: 1, col: 1 }],
    state: "completed",
    verdict: "passed",
    flags: [],
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
  return {
    ...actual,
    FileClassificationCache: { load: vi.fn(async () => ({})) },
    PlaywrightBrowserDriver: class {},
    runFlow: vi.fn(
      async (
        file: string,
        dependencies: {
          report?: { recorder: InstanceType<typeof actual.RunRecorder> };
        },
      ) => {
        await dependencies.report?.recorder.startTest({
          id: `test:${path.basename(file)}`,
          file,
        });
        await dependencies.report?.recorder.addStep({
          ...fixtureStep,
          id: `step:${path.basename(file)}`,
        });
        await dependencies.report?.recorder.finishTest("passed");
        return { status: "passed" as const, file };
      },
    ),
  };
});

import { executeRunCommand } from "./run-command.js";
import { renderDiagnostic } from "./diagnostics.js";
import { ProgressWriter, ProgressWriterError } from "./progress-writer.js";

let root: string | undefined;
let previous: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (previous) process.chdir(previous);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  previous = undefined;
});

async function inTemporaryRoot() {
  root = await mkdtemp(path.join(tmpdir(), "sedum-output-failure-"));
  previous = process.cwd();
  process.chdir(root);
  await writeFile(
    path.join(root, "fixture.test.yaml"),
    "url: https://example.test\nsteps: [verify page]\n",
  );
  vi.mocked(runFlow).mockClear();
}

function longTemporaryRoot() {
  return path.join(
    root!,
    ...Array.from(
      { length: 28 },
      (_, index) => `long-output-path-${String(index).padStart(2, "0")}`,
    ),
  );
}

const options = {
  file: "fixture.test.yaml",
  replay: false,
  evidence: false,
  sensitiveOrigins: [],
};

describe("run output failure contract", () => {
  it("keeps valid artifacts and returns an operational result when a reporter throws", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      onSnapshot: () => {
        throw new Error("display is unavailable");
      },
    });
    expect(output.reporterFailed).toBe(true);
    expect(output.artifacts.authoritative).toBe(true);
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "reporter_output_error" },
    });
    expect(
      validateRunResult(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ),
    ).toEqual(output.result);
  });

  it("preserves completed steps when live reporter output fails", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      onSnapshot: (snapshot) => {
        if (snapshot.tests[0]?.attempts[0]?.steps.length)
          throw new Error("display is unavailable");
      },
    });
    expect(output.result).toMatchObject({
      state: "error",
      error: { code: "reporter_output_error" },
    });
    expect(output.result.tests[0]?.attempts[0]?.steps).toHaveLength(1);
    expect(
      validateRunResult(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ),
    ).toEqual(output.result);
  });

  it("replaces a completed result when final reporter output fails", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      onSnapshot: (snapshot) => {
        if (snapshot.state === "completed")
          throw new Error("display is unavailable");
      },
    });
    expect(output.reporterFailed).toBe(true);
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      totals: { passedTests: 1 },
      error: { code: "reporter_output_error" },
    });
  });

  it("can record a reporter failure after result.json was first committed", async () => {
    await inTemporaryRoot();
    const initial = await executeRunCommand(options);
    const failure = await initial.onReporterFailure?.();
    expect(failure?.result).toMatchObject({
      state: "error",
      verdict: null,
      totals: { passedTests: 1 },
      error: { code: "reporter_output_error" },
    });
    expect(
      validateRunResult(
        JSON.parse(await readFile(initial.artifacts.resultPath, "utf8")),
      ),
    ).toEqual(failure?.result);
  });

  it("rejects unavailable reporter choices before starting a browser or provider", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      reporters: ["junit"],
    });
    expect(output.result).toMatchObject({
      state: "error",
      error: { code: "unsupported_reporter" },
    });
    expect(runFlow).not.toHaveBeenCalled();
    expect(output.artifacts.authoritative).toBe(true);
  });

  it("writes requested JSON to the project-root reporter directory from the same final result", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      reporters: ["json", "json"],
      reporterDir: "reports",
    });
    const reporterPath = path.join(
      root!,
      "reports",
      output.result.runId,
      "result.json",
    );
    expect(output.artifacts.reporterPath).toMatch(/[/\\]reports[/\\]/u);
    expect(JSON.parse(await readFile(reporterPath, "utf8"))).toEqual(
      output.result,
    );
    expect(
      JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
    ).toEqual(output.result);
  });

  it("uses the canonical JSON when reporter and output directories coincide", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      reporters: ["json"],
      outputDir: "same",
      reporterDir: "same",
    });
    expect(output.result.state).toBe("completed");
    expect(output.artifacts.reporterPath).toBe(output.artifacts.resultPath);
  });

  it("makes a reporter write failure operational while retaining the canonical result", async () => {
    await inTemporaryRoot();
    const finish = ProgressWriter.prototype.finish;
    vi.spyOn(ProgressWriter.prototype, "finish").mockImplementation(
      async function (this: ProgressWriter, result) {
        if (this.directory.includes(`${path.sep}reports${path.sep}`))
          throw new ProgressWriterError(this.resultPath);
        return finish.call(this, result);
      },
    );
    const output = await executeRunCommand({
      ...options,
      reporterDir: "reports",
    });
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "output_error" },
    });
    expect(output.artifacts.reporterPath).toBeUndefined();
    expect(
      JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
    ).toEqual(output.result);
  });

  it("keeps an earlier run error primary when its reporter write fails", async () => {
    await inTemporaryRoot();
    const finish = ProgressWriter.prototype.finish;
    vi.spyOn(ProgressWriter.prototype, "finish").mockImplementation(
      async function (this: ProgressWriter, result) {
        if (this.directory.includes(`${path.sep}reports${path.sep}`))
          throw new ProgressWriterError(this.resultPath);
        return finish.call(this, result);
      },
    );
    const output = await executeRunCommand({
      ...options,
      paths: ["missing.test.yaml"],
      reporterDir: "reports",
    });
    expect(output.result.error?.code).toBe("no_tests");
    expect(output.diagnostic?.code).toBe("output_error");
    expect(
      JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
    ).toEqual(output.result);
  });

  it("runs valid selected files but exits incomplete when another selected file is invalid", async () => {
    await inTemporaryRoot();
    await writeFile(
      path.join(root!, "good.test.yaml"),
      "url: https://example.test\nsteps: [verify page]\n",
    );
    await writeFile(path.join(root!, "bad.test.yaml"), "stepz: []\n");
    const output = await executeRunCommand({
      ...options,
      paths: ["good.test.yaml", "bad.test.yaml"],
    });
    expect(
      vi.mocked(runFlow).mock.calls.map(([file]) => path.basename(file)),
    ).toEqual(["good.test.yaml"]);
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "discovery_error" },
      totals: { executedTests: 1 },
    });
    expect(output.result.discoveryProblems?.[0]).toMatchObject({
      file: "bad.test.yaml",
      line: 1,
      col: 1,
    });
  });

  it("keeps URLs and credentials out of invalid-file result diagnostics", async () => {
    await inTemporaryRoot();
    await writeFile(
      path.join(root!, "private.test.yaml"),
      '"https://user:password@example.test/private?token=abc": true\nsteps: [verify page]\n',
    );
    const output = await executeRunCommand({
      ...options,
      paths: ["private.test.yaml"],
    });
    const resultText = JSON.stringify(output.result);
    expect(output.result.error?.code).toBe("no_tests");
    expect(output.result.discoveryProblems?.[0]?.line).toBe(1);
    expect(resultText).not.toContain("password");
    expect(resultText).not.toContain("token=abc");
  });

  it("retries a failed test as a fresh numbered attempt and keeps both outcomes", async () => {
    await inTemporaryRoot();
    await writeFile(
      path.join(root!, "fixture.test.yaml"),
      "url: https://example.test\nsteps: [verify page]\n",
    );
    let calls = 0;
    vi.mocked(runFlow).mockImplementationOnce(async (file, dependencies) => {
      const recorder = dependencies.report!.recorder;
      await recorder.startTest({ id: "retry-test", file });
      await recorder.addStep({
        id: "retry-test:attempt:1:step:1",
        index: 1,
        kind: "verify",
        operation: "verify",
        phase: "steps",
        sentence: "verify page",
        detail: "failed",
        sourceStack: [{ file: "fixture.test.yaml", line: 2, col: 1 }],
        state: "completed",
        verdict: "failed",
        flags: [],
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
      });
      await recorder.finishTest("failed");
      calls++;
      return { status: "failed", file, source: { file, line: 2, col: 1 } };
    });
    vi.mocked(runFlow).mockImplementationOnce(async (file, dependencies) => {
      const recorder = dependencies.report!.recorder;
      await recorder.addStep({
        id: "retry-test:attempt:2:step:1",
        index: 1,
        kind: "verify",
        operation: "verify",
        phase: "steps",
        sentence: "verify page",
        detail: "passed",
        sourceStack: [{ file: "fixture.test.yaml", line: 2, col: 1 }],
        state: "completed",
        verdict: "passed",
        flags: [],
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
      });
      await recorder.finishTest("passed");
      calls++;
      return { status: "passed", file };
    });
    const output = await executeRunCommand({
      ...options,
      paths: ["fixture.test.yaml"],
      retries: 1,
    });
    expect(calls).toBe(2);
    expect(output.result.tests).toHaveLength(1);
    expect(
      output.result.tests[0]?.attempts.map((attempt) => attempt.verdict),
    ).toEqual(["failed", "passed"]);
    expect(output.result).toMatchObject({
      verdict: "passed",
      totals: { historicalAttempts: 1, failedTests: 0, passedTests: 1 },
    });
  });

  it("expires an active run with a typed error and partial attempt", async () => {
    await inTemporaryRoot();
    await writeFile(
      path.join(root!, "fixture.test.yaml"),
      "url: https://example.test\nsteps: [verify page]\n",
    );
    await writeFile(
      path.join(root!, "later.test.yaml"),
      "url: https://example.test\nsteps: [verify page]\n",
    );
    vi.mocked(runFlow).mockImplementationOnce(async (file, dependencies) => {
      await dependencies.report!.recorder.startTest({ id: "timed-test", file });
      await new Promise<void>((resolve) => {
        if (dependencies.signal?.aborted) resolve();
        else
          dependencies.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return {
        status: "could_not_run",
        file,
        code: "canceled",
        message: "canceled",
      };
    });
    const onDeadline = vi.fn();
    const output = await executeRunCommand({
      ...options,
      paths: ["fixture.test.yaml", "later.test.yaml"],
      timeoutMinutes: 0.02,
      onDeadline,
    });
    expect(onDeadline).toHaveBeenCalledOnce();
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "run_timeout" },
    });
    expect(output.result.tests[0]?.attempts[0]?.state).toBe("error");
    expect(output.result.tests[0]?.attempts[0]?.timeoutReason).toBe(
      "run_timeout",
    );
    expect(output.result.totals).toMatchObject({
      selectedTests: 2,
      executedTests: 1,
    });
  });

  it("keeps an earlier interrupt primary when its cleanup crosses the run deadline", async () => {
    await inTemporaryRoot();
    const interrupt = new AbortController();
    const onDeadline = vi.fn();
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(runFlow).mockImplementationOnce(async (file, dependencies) => {
      await dependencies.report!.recorder.startTest({
        id: "interrupted",
        file,
      });
      await new Promise<void>((resolve) => {
        dependencies.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
        started();
      });
      await new Promise((resolve) => setTimeout(resolve, 90));
      return {
        status: "could_not_run",
        file,
        code: "canceled",
        message: "canceled",
      };
    });
    const execution = executeRunCommand({
      ...options,
      signal: interrupt.signal,
      timeoutMinutes: 0.02,
      onDeadline,
    });
    await running;
    interrupt.abort(new Error("SIGINT"));
    const output = await execution;
    expect(output.result).toMatchObject({
      state: "interrupted",
      error: { code: "canceled" },
    });
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it("returns an operational result for invalid config before starting a test", async () => {
    await inTemporaryRoot();
    await writeFile(
      path.join(root!, "sedum.config.yaml"),
      "browser: firefox\n",
    );
    const output = await executeRunCommand({
      replay: false,
      evidence: false,
      sensitiveOrigins: [],
    });
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "invalid_config_browser" },
    });
    expect(output.diagnostic?.message).toContain("sedum.config.yaml");
    expect(output.diagnostic?.message).toContain("key: browser");
    expect(runFlow).not.toHaveBeenCalled();
  });

  it("returns an operational result when configured discovery selects no tests", async () => {
    await inTemporaryRoot();
    await writeFile(path.join(root!, "sedum.config.yaml"), "{}\n");
    const output = await executeRunCommand({
      replay: false,
      evidence: false,
      sensitiveOrigins: [],
    });
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "no_tests" },
    });
    expect(output.artifacts.authoritative).toBe(true);
    expect(runFlow).not.toHaveBeenCalled();
  });

  it("runs configured files without a positional argument and threads resolved settings", async () => {
    await inTemporaryRoot();
    await mkdir(path.join(root!, "specs"));
    await writeFile(
      path.join(root!, "sedum.config.yaml"),
      `tests:
  directory: specs
  exclude: ["skip-*.test.yaml"]
browser: chromium
viewport: { width: 900, height: 600 }
thresholds: { verify: 0.8, lowConfidenceBand: 0.1, contradiction: 0.4 }
outputDir: artifacts/runs
baseUrl: https://example.com/app/
`,
    );
    await writeFile(
      path.join(root!, "specs", "b.test.yaml"),
      "steps: [verify b]\n",
    );
    await writeFile(
      path.join(root!, "specs", "a.test.yaml"),
      "steps: [verify a]\n",
    );
    await writeFile(
      path.join(root!, "specs", "skip-x.test.yaml"),
      "steps: [verify x]\n",
    );
    const output = await executeRunCommand({
      replay: false,
      evidence: false,
      sensitiveOrigins: [],
    });
    expect(output.result).toMatchObject({
      state: "completed",
      verdict: "passed",
      totals: { selectedTests: 2, executedTests: 2 },
    });
    expect(output.artifacts.resultPath).toContain(
      path.join("artifacts", "runs"),
    );
    expect(
      vi.mocked(runFlow).mock.calls.map(([file]) => path.basename(file)),
    ).toEqual(["a.test.yaml", "b.test.yaml"]);
    expect(vi.mocked(runFlow).mock.calls[0]?.[1]).toMatchObject({
      browserKind: "chromium",
      viewport: { width: 900, height: 600 },
      verifyPolicy: { minP: 0.8, band: 0.1, contradictionCutoff: 0.4 },
      baseUrl: "https://example.com/app/",
    });
    expect(vi.mocked(runFlow).mock.calls[0]?.[1].repoRoot).toMatch(
      new RegExp(`${path.basename(root!)}$`, "u"),
    );
  });

  it("persists an authoritative successful result", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand(options);
    expect(output.result).toMatchObject({
      state: "completed",
      verdict: "passed",
    });
    expect(output.artifacts.authoritative).toBe(true);
    expect(output.diagnostic).toBeNull();
  });

  it("applies run filters to configured discovery with no positional paths", async () => {
    await inTemporaryRoot();
    await mkdir(path.join(root!, "tests"));
    await writeFile(
      path.join(root!, "tests", "one.test.yaml"),
      "id: one\ntags: [smoke]\nsteps: [verify page]\n",
    );
    await writeFile(
      path.join(root!, "tests", "two.test.yaml"),
      "id: two\ntags: [other]\nsteps: [verify page]\n",
    );
    const output = await executeRunCommand({
      replay: false,
      evidence: false,
      sensitiveOrigins: [],
      filters: { labels: ["smoke"] },
    });
    expect(output.result.totals).toMatchObject({
      selectedTests: 1,
      executedTests: 1,
    });
    expect(vi.mocked(runFlow).mock.calls[0]?.[0]).toMatch(
      /[/\\]tests[/\\]one\.test\.yaml$/u,
    );
  });

  it("reports directory creation failure without claiming an artifact", async () => {
    await inTemporaryRoot();
    vi.spyOn(ProgressWriter, "create").mockRejectedValueOnce(
      new Error("permission denied secret"),
    );
    const output = await executeRunCommand(options);
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "output_error" },
    });
    expect(output.artifacts.authoritative).toBe(false);
    expect(output.diagnostic?.fix).toContain("writable");
    expect(JSON.stringify(output)).not.toContain("permission denied secret");
  });

  it("keeps a long intended path in display text but out of the canonical error", async () => {
    await inTemporaryRoot();
    const deep = longTemporaryRoot();
    vi.spyOn(process, "cwd").mockReturnValue(deep);
    vi.spyOn(ProgressWriter, "create").mockRejectedValueOnce(
      new Error("permission denied"),
    );
    const output = await executeRunCommand(options);
    const intended = path.join(
      deep,
      ".sedum",
      "runs",
      output.result.runId,
      "result.json",
    );
    expect(output.artifacts.authoritative).toBe(false);
    expect(output.result.error?.message).toBe(
      "The run result could not be written.",
    );
    expect(output.result.error?.message.length).toBeLessThanOrEqual(512);
    expect(renderDiagnostic(output.diagnostic!)).toContain(intended);
  });

  it("stops on a mid-run progress write failure", async () => {
    await inTemporaryRoot();
    const write = ProgressWriter.prototype.write;
    let writes = 0;
    vi.spyOn(ProgressWriter.prototype, "write").mockImplementation(function (
      this: ProgressWriter,
      result,
    ) {
      writes += 1;
      return writes === 3
        ? Promise.reject(new ProgressWriterError("progress.json"))
        : write.call(this, result);
    });
    const output = await executeRunCommand(options);
    expect(output.result.state).toBe("error");
    expect(output.result.tests[0]).toMatchObject({
      file: expect.stringMatching(/fixture\.test\.yaml$/u),
      state: "running",
    });
    expect(output.artifacts.authoritative).toBe(false);
  });

  it("retains completed tests but invalidates a failed final result write", async () => {
    await inTemporaryRoot();
    vi.spyOn(ProgressWriter.prototype, "finish").mockRejectedValueOnce(
      new ProgressWriterError("result.json"),
    );
    const output = await executeRunCommand(options);
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      totals: { executedTests: 1, passedTests: 1 },
      error: { code: "output_error" },
    });
    expect(output.result.tests[0]).toMatchObject({ verdict: "passed" });
    expect(output.artifacts.authoritative).toBe(false);
    await expect(
      import("node:fs/promises").then(({ access }) =>
        access(output.artifacts.progressPath),
      ),
    ).rejects.toThrow();
  });

  it("survives a final write failure under a long output path", async () => {
    await inTemporaryRoot();
    const longResultPath = path.join(
      longTemporaryRoot(),
      ".sedum",
      "runs",
      "run-id",
      "result.json",
    );
    vi.spyOn(ProgressWriter.prototype, "finish").mockImplementationOnce(() =>
      Promise.reject(new ProgressWriterError(longResultPath)),
    );
    const output = await executeRunCommand(options);
    expect(output.artifacts.authoritative).toBe(false);
    expect(output.result).toMatchObject({
      state: "error",
      error: {
        code: "output_error",
        message: "The run result could not be written.",
      },
    });
    expect(renderDiagnostic(output.diagnostic!)).toContain("result.json");
    expect(renderDiagnostic(output.diagnostic!).length).toBeGreaterThan(512);
  });

  it("commits the outcome before final persistence so late signals are ignored", async () => {
    await inTemporaryRoot();
    const controller = new AbortController();
    let committed = false;
    const finish = ProgressWriter.prototype.finish;
    vi.spyOn(ProgressWriter.prototype, "finish").mockImplementationOnce(
      async function (this: ProgressWriter, result) {
        expect(committed).toBe(true);
        controller.abort();
        await finish.call(this, result);
      },
    );
    const output = await executeRunCommand({
      ...options,
      signal: controller.signal,
      onCommitted: () => {
        committed = true;
      },
    });
    expect(output.result).toMatchObject({
      state: "completed",
      verdict: "passed",
    });
  });

  it("bounds and redacts an arbitrary oversized runtime failure", async () => {
    await inTemporaryRoot();
    vi.mocked(runFlow).mockResolvedValueOnce({
      status: "could_not_run",
      file: "fixture.test.yaml",
      code: "execution_error",
      message: `${"x".repeat(700)} sentinel-secret`,
      fix: "leak sentinel-secret",
    });
    const output = await executeRunCommand(options);
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "execution_error" },
    });
    expect(JSON.stringify(output)).not.toContain("sentinel-secret");
    const stored = validateRunResult(
      JSON.parse(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(output.artifacts.resultPath, "utf8"),
        ),
      ),
    );
    expect(stored).toEqual(output.result);
  });
});
