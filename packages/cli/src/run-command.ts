import {
  FileClassificationCache,
  PlaywrightBrowserDriver,
  RunRecorder,
  runFlow,
  safeText,
  validateRunResult,
  type RunResult,
  type BrowserKind,
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
import { openLocatorCache } from "./locator-cache-store.js";
import type { RunArtifactPaths } from "./output.js";
import {
  loadProjectConfig,
  ProjectConfigError,
  type ResolvedProjectConfig,
} from "./config.js";
import { discoverRunTests, type RunFilters } from "./run-selection.js";

export interface RunCommandOptions {
  readonly file?: string;
  readonly paths?: readonly string[];
  readonly filters?: RunFilters;
  readonly environment?: string;
  readonly browser?: string;
  readonly urlOverride?: string;
  readonly outputDir?: string;
  readonly reporterDir?: string;
  readonly reporters?: readonly string[];
  readonly headed?: boolean;
  readonly slowMoMs?: number;
  readonly retries?: number;
  readonly timeoutMinutes?: number;
  readonly replay: boolean;
  readonly evidence: boolean;
  readonly sensitiveOrigins: readonly string[];
  readonly locatorCacheDisabled?: boolean;
  readonly locatorCacheCi?: boolean;
  readonly signal?: AbortSignal;
  readonly onSnapshot?: (snapshot: RunResult) => void;
  readonly onCommitted?: () => void;
  readonly onDeadline?: () => void;
}

export interface RunCommandExecution {
  readonly result: RunResult;
  readonly artifacts: RunArtifactPaths;
  readonly diagnostic: CliDiagnostic | null;
}

function safeDiscoveryText(
  value: string,
  config: ResolvedProjectConfig,
): string {
  const withoutUrls = value.replace(/https?:\/\/[^\s`"'<>]+/giu, "[URL]");
  return safeText(
    withoutUrls,
    {
      secretValues: Object.values(config.variables).filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length >= 4,
      ),
    },
    512,
  );
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
  discoveryProblems: NonNullable<RunResult["discoveryProblems"]> = [],
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
  if (discoveryProblems.length)
    await recorder.addDiscoveryProblems(discoveryProblems);
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
    if (
      options.browser &&
      options.browser !== "chrome" &&
      options.browser !== "chromium"
    )
      throw new ProjectConfigError([
        {
          code: "invalid_browser",
          file: path.join(invocationRoot, "sedum.config.yaml"),
          line: 1,
          col: 1,
          key: "browser",
          message: "Browser must be chrome or chromium.",
          fix: "Use --browser chrome or --browser chromium.",
        },
      ]);
    if (options.urlOverride) {
      let valid = false;
      try {
        const url = new URL(options.urlOverride);
        valid =
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password;
      } catch {
        /* handled below without echoing the URL */
      }
      if (!valid)
        throw new ProjectConfigError([
          {
            code: "invalid_url_override",
            file: path.join(invocationRoot, "sedum.config.yaml"),
            line: 1,
            col: 1,
            key: "urlOverride",
            message:
              "The URL override must be an absolute HTTP(S) URL without credentials.",
            fix: "Use --url-override https://preview.example.com.",
          },
        ]);
    }
    config = await loadProjectConfig(invocationRoot, process.env, {
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.browser ? { browser: options.browser as BrowserKind } : {}),
      ...(options.outputDir ? { outputDir: options.outputDir } : {}),
      ...(options.reporterDir ? { reporterDir: options.reporterDir } : {}),
    });
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

  const unavailable = (options.reporters ?? []).find(
    (reporter) => reporter !== "terminal" && reporter !== "json",
  );
  if (unavailable)
    return configuredOperationalFailure(
      config,
      runId,
      {
        code: "unsupported_reporter",
        message: `Reporter ${JSON.stringify(unavailable)} is not available in this build.`,
        fix: "Use --reporter terminal or --reporter json.",
      },
      commit,
    );
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onExternalAbort();
  else
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timeout =
    options.timeoutMinutes === undefined
      ? undefined
      : setTimeout(() => {
          if (controller.signal.aborted) return;
          timedOut = true;
          controller.abort(new Error("run_timeout"));
          options.onDeadline?.();
        }, options.timeoutMinutes * 60_000);
  const signal = controller.signal;
  try {
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
    } catch {
      commit();
      const diagnostic = outputDiagnostic(writer.progressPath);
      await writer.invalidate();
      return {
        result: await resultWithoutSink(runId, diagnostic),
        artifacts: { ...artifacts, authoritative: false },
        diagnostic,
      };
    }
    let reportWriter: ProgressWriter | undefined;
    const requestedJsonReport =
      Boolean(options.reporterDir) ||
      Boolean(options.reporters?.includes("json"));
    const reporterUsesCanonicalDirectory =
      requestedJsonReport &&
      path.resolve(config.reporterDir) === path.resolve(config.outputDir);
    if (requestedJsonReport && !reporterUsesCanonicalDirectory) {
      try {
        reportWriter = await ProgressWriter.create(
          config.projectRoot,
          runId,
          config.reporterDir,
        );
      } catch {
        const diagnostic = outputDiagnostic(
          path.join(config.reporterDir, runId, "result.json"),
        );
        commit();
        await recorder.finish(canonicalDiagnosticError(diagnostic));
        await writer.finish(recorder.snapshot);
        return { result: recorder.snapshot, artifacts, diagnostic };
      }
    }
    const reportedArtifacts: RunArtifactPaths = requestedJsonReport
      ? {
          ...artifacts,
          reporterPath: reportWriter?.resultPath ?? writer.resultPath,
        }
      : artifacts;
    const finishArtifacts = async (): Promise<CliDiagnostic | null> => {
      if (reportWriter) {
        try {
          await reportWriter.finish(recorder.snapshot);
        } catch {
          const diagnostic = outputDiagnostic(reportWriter.resultPath);
          await reportWriter.invalidate();
          if (recorder.snapshot.error === null)
            await recorder.finish(canonicalDiagnosticError(diagnostic));
          await writer.finish(recorder.snapshot);
          return diagnostic;
        }
      }
      await writer.finish(recorder.snapshot);
      return null;
    };
    const terminalExecution = async (
      diagnostic: CliDiagnostic | null,
    ): Promise<RunCommandExecution> => {
      try {
        const reportFailure = await finishArtifacts();
        return {
          result: recorder.snapshot,
          artifacts: reportFailure ? artifacts : reportedArtifacts,
          diagnostic: reportFailure ?? diagnostic,
        };
      } catch (error) {
        const output = outputDiagnostic(
          error instanceof ProgressWriterError ? error.path : writer.resultPath,
        );
        const result = terminalOutputFailure(recorder.snapshot, output);
        await writer.invalidate();
        await reportWriter?.invalidate();
        return {
          result,
          artifacts: { ...artifacts, authoritative: false },
          diagnostic: output,
        };
      }
    };
    let files: readonly string[];
    let discoveryProblems: NonNullable<RunResult["discoveryProblems"]> = [];
    try {
      const selection = await discoverRunTests(
        config,
        options.paths ?? (options.file ? [options.file] : []),
        options.filters,
      );
      files = selection.tests.map((test) =>
        path.join(config.projectRoot, test.file),
      );
      discoveryProblems = [
        ...selection.problems,
        ...selection.invalid.flatMap((entry) =>
          entry.diagnostics.map((item) => ({
            file: entry.file,
            line: item.line,
            col: item.col,
            code: item.code,
            message: safeDiscoveryText(item.message, config),
            fix: safeDiscoveryText(item.fix, config),
          })),
        ),
      ];
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
      const diagnostic = setupDiagnostic(error);
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
      return terminalExecution(diagnostic);
    }
    if (signal.aborted) {
      const diagnostic: CliDiagnostic = timedOut
        ? {
            code: "run_timeout",
            message: "The run deadline expired.",
            fix: "Increase --timeout-minutes or reduce the selected suite.",
          }
        : {
            code: "canceled",
            message: "The run was interrupted.",
            fix: "Rerun the command when you are ready to continue.",
          };
      if (discoveryProblems.length)
        await recorder.addDiscoveryProblems(discoveryProblems);
      commit();
      await recorder.finish(
        canonicalDiagnosticError(diagnostic),
        timedOut ? "error" : "interrupted",
      );
      return terminalExecution(diagnostic);
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
          message: "The selection matched no valid test files.",
          fix: "Add a matching *.test.yaml file or correct paths and filters.",
        },
      ]);
      const diagnostic = setupDiagnostic(error);
      if (discoveryProblems.length)
        await recorder.addDiscoveryProblems(discoveryProblems);
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
      return terminalExecution(diagnostic);
    }

    try {
      await recorder.selectTests(files.length);
      if (discoveryProblems.length)
        await recorder.addDiscoveryProblems(discoveryProblems);
      if (signal.aborted) throw new Error("canceled");
      const provider = new TypeSafeAdapter(
        config.apiKey ? { apiKey: config.apiKey } : {},
      );
      const cache = await FileClassificationCache.load(
        path.join(config.projectRoot, ".sedum", "classifications.json"),
        "jev-latest",
      );
      const locatorCache = await openLocatorCache(config.projectRoot, {
        disabled: options.locatorCacheDisabled ?? false,
        ciOptIn: options.locatorCacheCi ?? false,
        env: process.env,
      });
      let operational: ReturnType<typeof flowDiagnostic> | null = null;
      const browser = new PlaywrightBrowserDriver();
      for (const file of files) {
        for (let attempt = 0; attempt <= (options.retries ?? 0); attempt++) {
          if (attempt > 0) await recorder.startAttempt();
          const result = await runFlow(file, {
            repoRoot: config.projectRoot,
            browser,
            provider,
            classificationCache: cache,
            locatorCache,
            env: config.variables,
            browserKind: config.browser,
            viewport: config.viewport,
            verifyPolicy: config.thresholds,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...(options.urlOverride
              ? { urlOverride: options.urlOverride }
              : {}),
            ...(options.headed ? { headless: false } : {}),
            ...(options.headed ? { headedOverlay: true } : {}),
            ...(options.slowMoMs !== undefined
              ? { slowMoMs: options.slowMoMs }
              : {}),
            signal,
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
          if (signal.aborted) break;
          if (result.status === "could_not_run") {
            operational = flowDiagnostic(result);
            break;
          }
          if (result.status === "passed") break;
        }
        if (operational || signal.aborted) break;
      }
      if (signal.aborted) {
        const diagnostic: CliDiagnostic = timedOut
          ? {
              code: "run_timeout",
              message: "The run deadline expired.",
              fix: "Increase --timeout-minutes or reduce the selected suite.",
            }
          : {
              code: "canceled",
              message: "The run was interrupted.",
              fix: "Rerun the command when you are ready to continue.",
            };
        commit();
        await recorder.finish(
          canonicalDiagnosticError(diagnostic),
          timedOut ? "error" : "interrupted",
        );
        return terminalExecution(diagnostic);
      }
      if (operational) {
        const diagnostic = operational;
        commit();
        await recorder.finish(canonicalDiagnosticError(diagnostic));
        return terminalExecution(diagnostic);
      }
      if (discoveryProblems.length) {
        const diagnostic: CliDiagnostic = {
          code: "discovery_error",
          message: `${discoveryProblems.length} test file or path problem(s) were found.`,
          fix: "Correct the files named in the run summary and rerun.",
        };
        commit();
        await recorder.finish(canonicalDiagnosticError(diagnostic));
        return terminalExecution(diagnostic);
      }
      commit();
      await recorder.finish();
      return terminalExecution(null);
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
      const diagnostic: CliDiagnostic = signal.aborted
        ? timedOut
          ? {
              code: "run_timeout",
              message: "The run deadline expired.",
              fix: "Increase --timeout-minutes or reduce the selected suite.",
            }
          : {
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
            signal.aborted && !timedOut ? "interrupted" : "error",
          );
        return terminalExecution(diagnostic);
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
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}
