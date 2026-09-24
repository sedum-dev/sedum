import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync, symlinkSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFlow, validateRunResult, type ResultStep } from "@sedum-dev/core";

vi.mock("@sedum-dev/provider-typesafe", () => ({
  TypeSafeAdapter: class {},
  ProviderGate: class {
    close() {}
  },
  DEFAULT_PROVIDER_CONCURRENCY: 4,
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
  it("keeps canonical JSON when the HTML report cannot be written", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      onSnapshot: (snapshot, artifacts) => {
        if (snapshot.state === "completed" && artifacts.htmlPath)
          symlinkSync("trap", artifacts.htmlPath);
      },
    });
    expect(output.artifacts.authoritative).toBe(true);
    expect(output.artifacts.htmlPath).toBeUndefined();
    expect(output.diagnostic?.code).toBe("reporter_output_error");
    expect(output.result).toMatchObject({
      state: "error",
      verdict: null,
      error: { code: "reporter_output_error" },
      totals: { passedTests: 1 },
    });
    expect(
      validateRunResult(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ),
    ).toEqual(output.result);
    expect(
      validateRunResult(
        JSON.parse(await readFile(output.artifacts.progressPath, "utf8")),
      ),
    ).toEqual(output.result);
  });

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
    expect(output.artifacts.htmlPath).toBeDefined();
    expect(await readFile(output.artifacts.htmlPath!, "utf8")).toContain(
      "run receipt",
    );
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

  it("writes report.md beside result.json only when markdown is requested", async () => {
    await inTemporaryRoot();
    const plain = await executeRunCommand({ ...options });
    expect(plain.artifacts.markdownPath).toBeUndefined();
    const output = await executeRunCommand({
      ...options,
      reporters: ["markdown", "json"],
      reporterDir: "reports",
    });
    expect(output.result.state).toBe("completed");
    expect(output.artifacts.markdownPath).toBe(
      path.join(path.dirname(output.artifacts.resultPath), "report.md"),
    );
    const markdown = await readFile(output.artifacts.markdownPath!, "utf8");
    expect(markdown).toMatch(/^# Sedum run\n\n\*\*passed\*\*/u);
    expect(markdown).toContain(`- **run**: \`${output.result.runId}\``);
    await expect(
      readFile(
        path.join(root!, "reports", output.result.runId, "report.md"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("keeps canonical JSON when the Markdown report cannot be written", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      reporters: ["markdown"],
      onSnapshot: (snapshot, artifacts) => {
        if (snapshot.state === "completed" && artifacts.markdownPath)
          symlinkSync("trap", artifacts.markdownPath);
      },
    });
    expect(output.artifacts.authoritative).toBe(true);
    expect(output.artifacts.markdownPath).toBeUndefined();
    expect(output.artifacts.htmlPath).toBeUndefined();
    expect(output.diagnostic).toMatchObject({
      code: "reporter_output_error",
      message: expect.stringContaining("Markdown report"),
    });
    expect(output.result).toMatchObject({
      state: "error",
      error: { code: "reporter_output_error" },
    });
    expect(
      validateRunResult(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ),
    ).toEqual(output.result);
    const directory = path.dirname(output.artifacts.resultPath);
    await expect(
      readFile(path.join(directory, "report.html"), "utf8"),
    ).rejects.toThrow();
  });

  it("keeps each concurrent run's and attempt's frames when runs share an output root", async () => {
    await inTemporaryRoot();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const failingAttempt = async (
      file: string,
      dependencies: Parameters<typeof runFlow>[1],
    ) => {
      const report = dependencies.report!;
      if (report.recorder.snapshot.tests.length === 0)
        await report.recorder.startTest({ id: "broken", file });
      const attempt = report.recorder.snapshot.tests[0]!.attempts.at(-1)!;
      // Yield so the two runs interleave their frame writes.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const evidence = await report.saveFrame(
        attempt,
        `${attempt.id}:step:1:evidence`,
        jpeg,
      );
      await report.recorder.addStep({
        id: `${attempt.id}:step:1`,
        index: 1,
        kind: "action",
        operation: "click",
        phase: "steps",
        sentence: "click the Checkout button",
        detail: "No candidate cleared the locator threshold.",
        sourceStack: [{ file: "fixture.test.yaml", line: 2, col: 1 }],
        state: "completed",
        verdict: "failed",
        flags: [],
        elapsedMs: 1,
        page: { status: "unavailable", reason: "fixture" },
        locator: {
          confidence: 0.2,
          source: "model",
          options: [{ label: "(no match)", role: "", probability: 0.8 }],
          cache: null,
        },
        judgement: null,
        observations: [],
        calls: [],
        error: { code: "target_not_found", message: "No Checkout button." },
        evidence,
        replayFrame: null,
        targetBox: null,
      });
      await report.recorder.finishTest("failed");
      return {
        status: "failed" as const,
        file,
        source: { file, line: 2, col: 1 },
      };
    };
    for (let call = 0; call < 6; call++)
      vi.mocked(runFlow).mockImplementationOnce(failingAttempt);
    const run = () =>
      executeRunCommand({
        ...options,
        paths: ["fixture.test.yaml"],
        retries: 1,
        reporters: ["markdown"],
      });
    const [first, second] = await Promise.all([run(), run()]);
    const frames = [first, second].flatMap((output) => {
      const directory = path.dirname(output.artifacts.resultPath);
      return output.result.tests[0]!.attempts.map((attempt) => {
        const evidence = attempt.steps[0]!.evidence;
        if (evidence.status !== "captured") throw new Error("No frame");
        return { directory, path: evidence.path };
      });
    });
    expect(frames).toHaveLength(4);
    expect(
      new Set(frames.map((f) => path.join(f.directory, f.path))).size,
    ).toBe(4);
    for (const frame of frames)
      expect(await readFile(path.join(frame.directory, frame.path))).toEqual(
        Buffer.from(jpeg),
      );
    for (const output of [first, second]) {
      const markdown = await readFile(output.artifacts.markdownPath!, "utf8");
      const links = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)].map(
        (match) => match[1]!,
      );
      expect(links).toHaveLength(1);
      const directory = path.dirname(output.artifacts.markdownPath!);
      expect(await readFile(path.join(directory, links[0]!))).toEqual(
        Buffer.from(jpeg),
      );
      expect(markdown).toContain("- **attempt**: 2 of 2; earlier #1 failed");
    }
    const snapshot = async (directory: string) => {
      const files = await readdir(directory, { recursive: true });
      return Promise.all(
        files.sort().map(async (file) => {
          const full = path.join(directory, file);
          return [
            file,
            (await lstat(full)).isFile() ? await readFile(full, "base64") : "",
          ];
        }),
      );
    };
    const directories = [first, second].map((output) =>
      path.dirname(output.artifacts.resultPath),
    );
    const before = await Promise.all(directories.map(snapshot));
    const third = await run();
    expect(path.dirname(third.artifacts.resultPath)).not.toBe(directories[0]);
    expect(await Promise.all(directories.map(snapshot))).toEqual(before);
  });

  it("rejects unavailable reporter choices before starting a browser or provider", async () => {
    await inTemporaryRoot();
    const output = await executeRunCommand({
      ...options,
      reporters: ["tap", "junit"],
    });
    expect(output.result).toMatchObject({
      state: "error",
      error: { code: "unsupported_reporter" },
    });
    expect(runFlow).not.toHaveBeenCalled();
    expect(output.artifacts.authoritative).toBe(true);
    // CI still gets a JUnit file whose run suite carries the error.
    expect(
      output.artifacts.junitPath?.endsWith(
        path.join(".sedum", "reports", output.result.runId, "junit.xml"),
      ),
    ).toBe(true);
    const junit = await readFile(output.artifacts.junitPath!, "utf8");
    expect(junit).toContain('<error type="unsupported_reporter"');
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

  describe("junit reporter", () => {
    const reportsDirectory = (runId: string) =>
      path.join(root!, "reports", runId);

    it("writes only junit.xml to the reporter directory when JSON is not requested", async () => {
      await inTemporaryRoot();
      const output = await executeRunCommand({
        ...options,
        reporters: ["junit"],
      });
      const directory = path.dirname(output.artifacts.junitPath!);
      expect(
        directory.endsWith(path.join(".sedum", "reports", output.result.runId)),
      ).toBe(true);
      expect(output.artifacts.reporterPath).toBeUndefined();
      expect((await readdir(directory)).sort()).toEqual(["junit.xml"]);
      const junit = await readFile(output.artifacts.junitPath!, "utf8");
      expect(junit).toContain('<property name="sedum.strict" value="false"/>');
      expect(junit).toContain(
        `<property name="sedum.run_id" value="${output.result.runId}"/>`,
      );
    });

    it("writes junit.xml beside the JSON copy, with --strict recorded", async () => {
      await inTemporaryRoot();
      const output = await executeRunCommand({
        ...options,
        reporters: ["json", "junit"],
        reporterDir: "reports",
        strict: true,
      });
      const directory = reportsDirectory(output.result.runId);
      expect((await readdir(directory)).sort()).toEqual([
        "junit.xml",
        "progress.json",
        "result.json",
      ]);
      expect(
        output.artifacts.reporterPath?.endsWith(
          path.join("reports", output.result.runId, "result.json"),
        ),
      ).toBe(true);
      expect(
        await readFile(path.join(directory, "junit.xml"), "utf8"),
      ).toContain('<property name="sedum.strict" value="true"/>');
      // The canonical directory never gets a JUnit copy.
      await expect(
        lstat(
          path.join(path.dirname(output.artifacts.resultPath), "junit.xml"),
        ),
      ).rejects.toThrow();
    });

    it("writes junit.xml into the canonical run directory when the directories coincide", async () => {
      await inTemporaryRoot();
      const output = await executeRunCommand({
        ...options,
        reporters: ["junit"],
        outputDir: "same",
        reporterDir: "same",
      });
      expect(output.artifacts.junitPath).toBe(
        path.join(path.dirname(output.artifacts.resultPath), "junit.xml"),
      );
      await lstat(output.artifacts.junitPath!);
    });

    it("writes the JUnit error suite for a config error", async () => {
      await inTemporaryRoot();
      await writeFile(
        path.join(root!, "sedum.config.yaml"),
        "browser: firefox\n",
      );
      const output = await executeRunCommand({
        replay: false,
        evidence: false,
        sensitiveOrigins: [],
        reporters: ["junit"],
      });
      expect(output.result.error?.code).toBe("invalid_config_browser");
      const junit = await readFile(output.artifacts.junitPath!, "utf8");
      expect(junit).toContain('<error type="invalid_config_browser"');
    });

    for (const placement of ["reporter directory", "canonical directory"])
      it(`drops every report when junit.xml cannot be written in the ${placement}`, async () => {
        await inTemporaryRoot();
        const output = await executeRunCommand({
          ...options,
          reporters: ["json", "junit", "markdown"],
          ...(placement === "canonical directory"
            ? { outputDir: "same", reporterDir: "same" }
            : { reporterDir: "reports" }),
          onSnapshot: (snapshot, artifacts) => {
            if (snapshot.state === "completed" && artifacts.junitPath)
              symlinkSync("trap", artifacts.junitPath);
          },
        });
        expect(output.diagnostic).toMatchObject({
          code: "reporter_output_error",
          message: expect.stringContaining("JUnit report"),
        });
        expect(output.result).toMatchObject({
          state: "error",
          error: { code: "reporter_output_error" },
        });
        expect(output.artifacts).toMatchObject({ authoritative: true });
        expect(output.artifacts.junitPath).toBeUndefined();
        expect(output.artifacts.htmlPath).toBeUndefined();
        expect(output.artifacts.markdownPath).toBeUndefined();
        const canonical = path.dirname(output.artifacts.resultPath);
        for (const report of ["report.html", "report.md"])
          await expect(lstat(path.join(canonical, report))).rejects.toThrow();
        for (const resultPath of [
          output.artifacts.resultPath,
          output.artifacts.reporterPath!,
        ])
          expect(
            validateRunResult(JSON.parse(await readFile(resultPath, "utf8"))),
          ).toEqual(output.result);
      });

    it("keeps an earlier run error primary when junit.xml then fails", async () => {
      await inTemporaryRoot();
      const output = await executeRunCommand({
        ...options,
        paths: ["missing.test.yaml"],
        reporters: ["junit"],
        reporterDir: "reports",
        onSnapshot: (snapshot, artifacts) => {
          if (snapshot.state !== "running" && artifacts.junitPath)
            symlinkSync("trap", artifacts.junitPath);
        },
      });
      expect(output.result.error?.code).toBe("no_tests");
      expect(output.diagnostic?.code).toBe("reporter_output_error");
      expect(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ).toEqual(output.result);
      expect(output.artifacts.htmlPath).toBeUndefined();
    });

    it("records a failed JSON copy in every canonical file before writing reports", async () => {
      await inTemporaryRoot();
      const finish = ProgressWriter.prototype.finish;
      vi.spyOn(ProgressWriter.prototype, "finish").mockImplementation(
        async function (this: ProgressWriter, result, only) {
          if (this.directory.includes(`${path.sep}reports${path.sep}`))
            throw new ProgressWriterError(this.resultPath);
          return finish.call(this, result, only);
        },
      );
      const output = await executeRunCommand({
        ...options,
        reporters: ["json", "junit", "markdown"],
        reporterDir: "reports",
      });
      expect(output.result).toMatchObject({
        state: "error",
        error: { code: "output_error" },
      });
      expect(output.artifacts.authoritative).toBe(true);
      expect(output.artifacts.reporterPath).toBeUndefined();
      expect(output.artifacts.junitPath).toBeUndefined();
      expect(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ).toEqual(output.result);
      // Reports exist only to describe the errored run, never a pass.
      expect(await readFile(output.artifacts.markdownPath!, "utf8")).toContain(
        "**error**",
      );
      await expect(
        lstat(path.join(reportsDirectory(output.result.runId), "junit.xml")),
      ).rejects.toThrow();
    });

    it("keeps canonical output when the whole reporter directory breaks", async () => {
      await inTemporaryRoot();
      const output = await executeRunCommand({
        ...options,
        reporters: ["json", "junit", "markdown"],
        reporterDir: "reports",
        onSnapshot: (snapshot) => {
          if (snapshot.state !== "completed") return;
          const directory = reportsDirectory(snapshot.runId);
          rmSync(directory, { recursive: true, force: true });
          symlinkSync(path.join(root!, "nowhere"), directory);
        },
      });
      expect(output.artifacts.authoritative).toBe(true);
      expect(output.result.error?.code).toBe("output_error");
      expect(output.artifacts.junitPath).toBeUndefined();
      expect(output.artifacts.reporterPath).toBeUndefined();
      expect(
        validateRunResult(
          JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
        ),
      ).toEqual(output.result);
      expect(await readFile(output.artifacts.markdownPath!, "utf8")).toContain(
        "**error**",
      );
    });

    it("rewrites junit.xml as an errored run when a terminal reporter fails", async () => {
      await inTemporaryRoot();
      const output = await executeRunCommand({
        ...options,
        reporters: ["junit"],
        onSnapshot: (snapshot) => {
          if (snapshot.state === "completed")
            throw new Error("display is unavailable");
        },
      });
      expect(output.result.error?.code).toBe("reporter_output_error");
      const junit = await readFile(output.artifacts.junitPath!, "utf8");
      expect(junit).toContain('<error type="reporter_output_error"');
      expect(junit).not.toContain(
        'value="passed"/>\n      <property name="sedum.strict"',
      );
    });

    it("gives up only the JSON copy when it cannot be rewritten after a report fails", async () => {
      await inTemporaryRoot();
      const finish = ProgressWriter.prototype.finish;
      vi.spyOn(ProgressWriter.prototype, "finish").mockImplementation(
        async function (this: ProgressWriter, result, only) {
          if (
            this.directory.includes(`${path.sep}reports${path.sep}`) &&
            result.error?.code === "reporter_output_error"
          )
            throw new ProgressWriterError(this.resultPath);
          return finish.call(this, result, only);
        },
      );
      const output = await executeRunCommand({
        ...options,
        reporters: ["json", "junit"],
        reporterDir: "reports",
        onSnapshot: (snapshot, artifacts) => {
          if (snapshot.state === "completed" && artifacts.htmlPath)
            symlinkSync("trap", artifacts.htmlPath);
        },
      });
      expect(output.artifacts.authoritative).toBe(true);
      expect(output.result.error?.code).toBe("reporter_output_error");
      expect(output.artifacts.reporterPath).toBeUndefined();
      expect(output.artifacts.junitPath).toBeUndefined();
      expect(
        JSON.parse(await readFile(output.artifacts.resultPath, "utf8")),
      ).toEqual(output.result);
      await expect(
        lstat(path.join(reportsDirectory(output.result.runId), "result.json")),
      ).rejects.toThrow();
    });

    it("puts a config error's JUnit file in --reporter-dir", async () => {
      await inTemporaryRoot();
      await writeFile(
        path.join(root!, "sedum.config.yaml"),
        "browser: firefox\n",
      );
      const output = await executeRunCommand({
        replay: false,
        evidence: false,
        sensitiveOrigins: [],
        reporters: ["junit"],
        reporterDir: "ci-reports",
      });
      expect(
        output.artifacts.junitPath?.endsWith(
          path.join("ci-reports", output.result.runId, "junit.xml"),
        ),
      ).toBe(true);
    });

    it("claims no files when a config error's run directory cannot be created", async () => {
      await inTemporaryRoot();
      await writeFile(
        path.join(root!, "sedum.config.yaml"),
        "browser: firefox\n",
      );
      await writeFile(path.join(root!, ".sedum"), "not a directory");
      const output = await executeRunCommand({
        replay: false,
        evidence: false,
        sensitiveOrigins: [],
        reporters: ["junit"],
      });
      expect(output.result.error?.code).toBe("invalid_config_browser");
      expect(output.artifacts.authoritative).toBe(false);
      expect(output.artifacts.junitPath).toBeUndefined();
    });

    it("invalidates a pre-run failure's files when its result cannot be written", async () => {
      await inTemporaryRoot();
      await writeFile(
        path.join(root!, "sedum.config.yaml"),
        "browser: firefox\n",
      );
      vi.spyOn(ProgressWriter.prototype, "finish").mockRejectedValue(
        new ProgressWriterError("result.json"),
      );
      const output = await executeRunCommand({
        replay: false,
        evidence: false,
        sensitiveOrigins: [],
        reporters: ["junit"],
      });
      expect(output.artifacts.authoritative).toBe(false);
      await expect(lstat(output.artifacts.resultPath)).rejects.toThrow();
    });

    it("names evidence relative to the CI checkout when the project is in a subdirectory", async () => {
      await inTemporaryRoot();
      const project = path.join(root!, "apps", "web");
      await mkdir(project, { recursive: true });
      await writeFile(path.join(project, "sedum.config.yaml"), "{}\n");
      await writeFile(
        path.join(project, "fixture.test.yaml"),
        "url: https://example.test\nsteps: [verify page]\n",
      );
      process.chdir(project);
      vi.mocked(runFlow).mockImplementationOnce(async (file, dependencies) => {
        const recorder = dependencies.report!.recorder;
        await recorder.startTest({ id: "failing", file: "fixture.test.yaml" });
        await recorder.addStep({
          id: "failing-step",
          index: 1,
          kind: "verify",
          operation: "verify",
          phase: "steps",
          sentence: "verify the page",
          detail: "",
          sourceStack: [{ file: "fixture.test.yaml", line: 2, col: 9 }],
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
          evidence: {
            status: "captured",
            path: "evidence/a1-000000000000/frame.jpg",
            mediaType: "image/jpeg",
          },
          replayFrame: null,
          targetBox: null,
        });
        await recorder.finishTest("failed");
        return { status: "failed" as const, file } as Awaited<
          ReturnType<typeof runFlow>
        >;
      });
      vi.stubEnv("CI_PROJECT_DIR", root!);
      vi.stubEnv("GITLAB_CI", "true");
      vi.stubEnv("WORKSPACE", "");
      vi.stubEnv("GITHUB_WORKSPACE", "");
      try {
        const output = await executeRunCommand({
          ...options,
          reporters: ["junit"],
        });
        const junit = await readFile(output.artifacts.junitPath!, "utf8");
        expect(junit).toContain(
          `[[ATTACHMENT|apps/web/.sedum/runs/${output.result.runId}/evidence/a1-000000000000/frame.jpg]]`,
        );
        expect(junit).not.toContain(root!);
      } finally {
        vi.unstubAllEnvs();
      }
    });
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
