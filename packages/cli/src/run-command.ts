import {
  FileClassificationCache,
  PlaywrightBrowserDriver,
  RunRecorder,
  runFlow,
  validateRunResult,
  type RunResult,
} from "@sedum-dev/core";
import { TypeSafeAdapter } from "@sedum-dev/provider-typesafe";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalDiagnosticError,
  flowDiagnostic,
  outputDiagnostic,
  setupDiagnostic,
  type CliDiagnostic,
} from "./diagnostics.js";
import { ProgressWriter, ProgressWriterError } from "./progress-writer.js";
import type { RunArtifactPaths } from "./output.js";
import {
  discoverConfiguredTests,
  loadProjectConfig,
  ProjectConfigError,
  type ResolvedProjectConfig,
} from "./config.js";

export interface RunCommandOptions {
  readonly file?: string;
  readonly replay: boolean;
  readonly evidence: boolean;
  readonly sensitiveOrigins: readonly string[];
  readonly signal?: AbortSignal;
  readonly onSnapshot?: (snapshot: RunResult) => void;
  readonly onCommitted?: () => void;
}

export interface RunCommandExecution {
  readonly result: RunResult;
  readonly artifacts: RunArtifactPaths;
  readonly diagnostic: CliDiagnostic | null;
}

function terminalOutputFailure(
  source: RunResult,
  diagnostic: CliDiagnostic,
): RunResult {
  const at = new Date().toISOString();
  return validateRunResult({
    ...source,
    state: "error",
    verdict: null,
    error: canonicalDiagnosticError(diagnostic),
    updatedAt: at,
    finishedAt: at,
  });
}

async function resultWithoutSink(
  runId: string,
  diagnostic: CliDiagnostic,
): Promise<RunResult> {
  const recorder = new RunRecorder(async () => undefined, runId);
  await recorder.start();
  await recorder.finish(canonicalDiagnosticError(diagnostic));
  return recorder.snapshot;
}

async function configuredOperationalFailure(
  config: ResolvedProjectConfig,
  runId: string,
  diagnostic: CliDiagnostic,
  commit: () => void,
): Promise<RunCommandExecution> {
  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(
      config.projectRoot,
      runId,
      config.outputDir,
    );
  } catch {
    commit();
    const intended = path.join(config.outputDir, runId);
    return {
      result: await resultWithoutSink(runId, diagnostic),
      artifacts: {
        progressPath: path.join(intended, "progress.json"),
        resultPath: path.join(intended, "result.json"),
        authoritative: false,
      },
      diagnostic,
    };
  }
  const recorder = new RunRecorder((snapshot) => writer.write(snapshot), runId);
  await recorder.start();
  commit();
  await recorder.finish(canonicalDiagnosticError(diagnostic));
  await writer.finish(recorder.snapshot);
  return {
    result: recorder.snapshot,
    artifacts: {
      progressPath: writer.progressPath,
      resultPath: writer.resultPath,
      authoritative: true,
    },
    diagnostic,
  };
}

export async function executeRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  const invocationRoot = process.cwd();
  const runId = randomUUID();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    options.onCommitted?.();
  };
  let config: ResolvedProjectConfig;
  try {
    config = await loadProjectConfig(invocationRoot);
  } catch (error) {
    const diagnostic = setupDiagnostic(error);
    const fallbackRoot =
      error instanceof ProjectConfigError && error.diagnostics[0]?.file
        ? path.dirname(error.diagnostics[0].file)
        : invocationRoot;
    const intended = path.join(fallbackRoot, ".sedum", "runs", runId);
    try {
      const fallback = await ProgressWriter.create(fallbackRoot, runId);
      const recorder = new RunRecorder(
        (snapshot) => fallback.write(snapshot),
        runId,
      );
      await recorder.start();
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
      await fallback.finish(recorder.snapshot);
      return {
        result: recorder.snapshot,
        artifacts: {
          progressPath: fallback.progressPath,
          resultPath: fallback.resultPath,
          authoritative: true,
        },
        diagnostic,
      };
    } catch {
      commit();
      return {
        result: await resultWithoutSink(runId, diagnostic),
        artifacts: {
          progressPath: path.join(intended, "progress.json"),
          resultPath: path.join(intended, "result.json"),
          authoritative: false,
        },
        diagnostic,
      };
    }
  }

  let files: readonly string[];
  try {
    files = options.file
      ? [path.resolve(config.projectRoot, options.file)]
      : await discoverConfiguredTests(config);
  } catch {
    const error = new ProjectConfigError([
      {
        code: "test_discovery_error",
        file: config.configPath ?? config.testDirectory,
        line: 1,
        col: 1,
        key: "tests.directory",
        message: "The configured test directory could not be read.",
        fix: "Check the test directory path and permissions, then try again.",
      },
    ]);
    return configuredOperationalFailure(
      config,
      runId,
      setupDiagnostic(error),
      commit,
    );
  }
  if (files.length === 0) {
    const error = new ProjectConfigError([
      {
        code: "no_tests",
        file:
          config.configPath ??
          path.join(config.projectRoot, "sedum.config.yaml"),
        line: 1,
        col: 1,
        key: "tests.include",
        message: "The configured test patterns matched no test files.",
        fix: "Add a matching *.test.yaml file or correct tests.directory/include/exclude.",
      },
    ]);
    return configuredOperationalFailure(
      config,
      runId,
      setupDiagnostic(error),
      commit,
    );
  }

  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(
      config.projectRoot,
      runId,
      config.outputDir,
    );
  } catch {
    commit();
    const intended = path.join(config.outputDir, runId);
    const diagnostic = outputDiagnostic(path.join(intended, "result.json"));
    return {
      result: await resultWithoutSink(runId, diagnostic),
      artifacts: {
        progressPath: path.join(intended, "progress.json"),
        resultPath: path.join(intended, "result.json"),
        authoritative: false,
      },
      diagnostic,
    };
  }

  const artifacts = {
    progressPath: writer.progressPath,
    resultPath: writer.resultPath,
    authoritative: true,
  } as const;
  const recorder = new RunRecorder(async (snapshot) => {
    await writer.write(snapshot);
    options.onSnapshot?.(snapshot);
  }, runId);

  try {
    await recorder.start();
    if (options.signal?.aborted) throw new Error("canceled");
    const provider = new TypeSafeAdapter(
      config.apiKey ? { apiKey: config.apiKey } : {},
    );
    const cache = await FileClassificationCache.load(
      path.join(config.projectRoot, ".sedum", "classifications.json"),
      "jev-latest",
    );
    let operational: ReturnType<typeof flowDiagnostic> | null = null;
    const browser = new PlaywrightBrowserDriver();
    for (const file of files) {
      const result = await runFlow(file, {
        repoRoot: config.projectRoot,
        browser,
        provider,
        classificationCache: cache,
        env: config.variables,
        browserKind: config.browser,
        viewport: config.viewport,
        verifyPolicy: config.thresholds,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        report: {
          recorder,
          privacy: {
            secretValues: [],
            sensitiveOrigins: options.sensitiveOrigins,
          },
          evidenceEnabled: options.evidence,
          replay: options.replay,
          saveFrame: (stepId, bytes) => writer.saveFrame(stepId, bytes),
        },
      });
      if (options.signal?.aborted) break;
      if (result.status === "could_not_run") {
        operational = flowDiagnostic(result);
        break;
      }
    }
    if (options.signal?.aborted) {
      const diagnostic: CliDiagnostic = {
        code: "canceled",
        message: "The run was interrupted.",
        fix: "Rerun the command when you are ready to continue.",
      };
      commit();
      await recorder.finish(
        canonicalDiagnosticError(diagnostic),
        "interrupted",
      );
      await writer.finish(recorder.snapshot);
      return { result: recorder.snapshot, artifacts, diagnostic };
    }
    if (operational) {
      const diagnostic = operational;
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
      await writer.finish(recorder.snapshot);
      return { result: recorder.snapshot, artifacts, diagnostic };
    }
    commit();
    await recorder.finish();
    await writer.finish(recorder.snapshot);
    return { result: recorder.snapshot, artifacts, diagnostic: null };
  } catch (error) {
    if (error instanceof ProgressWriterError) {
      commit();
      const diagnostic = outputDiagnostic(error.path);
      const result = terminalOutputFailure(recorder.snapshot, diagnostic);
      await writer.invalidate();
      return {
        result,
        artifacts: { ...artifacts, authoritative: false },
        diagnostic,
      };
    }
    const diagnostic: CliDiagnostic = options.signal?.aborted
      ? {
          code: "canceled",
          message: "The run was interrupted.",
          fix: "Rerun the command when you are ready to continue.",
        }
      : setupDiagnostic(error);
    commit();
    try {
      if (recorder.snapshot.state === "running")
        await recorder.finish(
          canonicalDiagnosticError(diagnostic),
          options.signal?.aborted ? "interrupted" : "error",
        );
      await writer.finish(recorder.snapshot);
      return { result: recorder.snapshot, artifacts, diagnostic };
    } catch (writeError) {
      const output = outputDiagnostic(
        writeError instanceof ProgressWriterError
          ? writeError.path
          : writer.resultPath,
      );
      const result = terminalOutputFailure(recorder.snapshot, output);
      await writer.invalidate();
      return {
        result,
        artifacts: { ...artifacts, authoritative: false },
        diagnostic: output,
      };
    }
  }
}
