import { mkdtemp, rm } from "node:fs/promises";
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
        await dependencies.report?.recorder.startTest({ id: "test", file });
        await dependencies.report?.recorder.addStep(fixtureStep);
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
      return writes === 2
        ? Promise.reject(new ProgressWriterError("progress.json"))
        : write.call(this, result);
    });
    const output = await executeRunCommand(options);
    expect(output.result.state).toBe("error");
    expect(output.result.tests[0]).toMatchObject({
      file: "fixture.test.yaml",
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
