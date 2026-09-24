import {
  FileClassificationCache,
  PlaywrightBrowserDriver,
  ReusableBrowserDriver,
  RunRecorder,
  runFlow,
  safeText,
  validateRunResult,
  type RunResult,
  type BrowserKind,
} from "@sedum-dev/core";
import {
  DEFAULT_PROVIDER_CONCURRENCY,
  ProviderGate,
  TypeSafeAdapter,
} from "@sedum-dev/provider-typesafe";
import path from "node:path";
import { availableParallelism } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
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
import { planLanes, runPool, type ParallelRequest } from "./run-pool.js";
import { shardProblems, shardTests, type ShardSpec } from "./run-shard.js";

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
  /** `--parallel`; defaults to one lane. */
  readonly parallel?: ParallelRequest;
  /** `--shard-index`/`--shard-count`, validated by the caller. */
  readonly shard?: ShardSpec;
  /** `--provider-concurrency`; defaults to min(4, lanes x 2). */
  readonly providerConcurrency?: number;
  /** Injected for tests; defaults to `os.availableParallelism()`. */
  readonly availableParallelism?: number;
  readonly replay: boolean;
  readonly evidence: boolean;
  readonly sensitiveOrigins: readonly string[];
  readonly locatorCacheDisabled?: boolean;
  readonly locatorCacheCi?: boolean;
  readonly signal?: AbortSignal;
  readonly onSnapshot?: (
    snapshot: RunResult,
    artifacts: RunArtifactPaths,
  ) => void;
  readonly onCommitted?: () => void;
  readonly onDeadline?: () => void;
}

export interface RunCommandExecution {
  readonly result: RunResult;
  readonly artifacts: RunArtifactPaths;
  readonly diagnostic: CliDiagnostic | null;
  readonly reporterFailed?: boolean;
  readonly onReporterFailure?: () => Promise<RunCommandExecution>;
}

class ReporterOutputError extends Error {}

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

interface FinalReportWrite {
  readonly result: RunResult;
  readonly diagnostic: CliDiagnostic | null;
  readonly reportsAvailable: boolean;
}

/** The rendered report files this writer produces, for the run summary. */
function reportArtifacts(writer: ProgressWriter): {
  htmlPath: string;
  markdownPath?: string;
} {
  return {
    htmlPath: writer.htmlPath,
    ...(writer.includeMarkdown ? { markdownPath: writer.markdownPath } : {}),
  };
}

function withoutReports(artifacts: RunArtifactPaths): RunArtifactPaths {
  return { ...artifacts, htmlPath: undefined, markdownPath: undefined };
}

async function finishCanonical(
  writer: ProgressWriter,
  result: RunResult,
): Promise<FinalReportWrite> {
  try {
    await writer.finish(result);
    return { result, diagnostic: null, reportsAvailable: true };
  } catch (error) {
    if (
      !(error instanceof ProgressWriterError) ||
      (error.path !== writer.htmlPath && error.path !== writer.markdownPath)
    )
      throw error;
    const format = error.path === writer.htmlPath ? "HTML" : "Markdown";
    const diagnostic: CliDiagnostic = {
      code: "reporter_output_error",
      message: `The ${format} report could not be written to ${error.path}.`,
      fix: "Check the run output directory and rerun the command.",
    };
    const failed = terminalOutputFailure(result, diagnostic);
    await writer.removeReports();
    await writer.finish(failed, false, false);
    return { result: failed, diagnostic, reportsAvailable: false };
  }
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
  includeMarkdown: boolean,
  discoveryProblems: NonNullable<RunResult["discoveryProblems"]> = [],
): Promise<RunCommandExecution> {
  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(
      config.projectRoot,
      runId,
      config.outputDir,
      true,
      includeMarkdown,
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
  const finished = await finishCanonical(writer, recorder.snapshot);
  return {
    result: finished.result,
    artifacts: {
      progressPath: writer.progressPath,
      resultPath: writer.resultPath,
      ...(finished.reportsAvailable ? reportArtifacts(writer) : {}),
      authoritative: true,
    },
    diagnostic: finished.diagnostic ?? diagnostic,
  };
}

export async function executeRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  const invocationRoot = process.cwd();
  const includeMarkdown = Boolean(options.reporters?.includes("markdown"));
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
      const fallback = await ProgressWriter.create(
        fallbackRoot,
        runId,
        undefined,
        true,
        includeMarkdown,
      );
      const recorder = new RunRecorder(
        (snapshot) => fallback.write(snapshot),
        runId,
      );
      await recorder.start();
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
      const finished = await finishCanonical(fallback, recorder.snapshot);
      return {
        result: finished.result,
        artifacts: {
          progressPath: fallback.progressPath,
          resultPath: fallback.resultPath,
          ...(finished.reportsAvailable ? reportArtifacts(fallback) : {}),
          authoritative: true,
        },
        diagnostic: finished.diagnostic ?? diagnostic,
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
    (reporter) =>
      !["terminal", "json", "list", "steps", "markdown"].includes(reporter),
  );
  if (unavailable)
    return configuredOperationalFailure(
      config,
      runId,
      {
        code: "unsupported_reporter",
        message: `Reporter ${JSON.stringify(unavailable)} is not available in this build.`,
        fix: "Use --reporter list, steps, terminal, json, or markdown.",
      },
      commit,
      includeMarkdown,
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
        true,
        includeMarkdown,
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
    const artifacts: RunArtifactPaths = {
      progressPath: writer.progressPath,
      resultPath: writer.resultPath,
      ...reportArtifacts(writer),
      authoritative: true,
    };
    let reporterFailed = false;
    let reportWriter: ProgressWriter | undefined;
    const recorder = new RunRecorder(async (snapshot) => {
      await writer.write(snapshot);
      if (!reporterFailed) {
        try {
          options.onSnapshot?.(snapshot, artifacts);
        } catch {
          reporterFailed = true;
          throw new ReporterOutputError(
            "The selected reporter could not write output.",
          );
        }
      }
    }, runId);
    const onReporterFailure = async (): Promise<RunCommandExecution> => {
      const diagnostic: CliDiagnostic = {
        code: "reporter_output_error",
        message: "The selected reporter could not write output.",
        fix: "Check terminal output access and rerun the command.",
      };
      const result = terminalOutputFailure(recorder.snapshot, diagnostic);
      try {
        await reportWriter?.finish(result);
        const finished = await finishCanonical(writer, result);
        if (finished.diagnostic) await reportWriter?.finish(finished.result);
        return {
          result: finished.result,
          artifacts: finished.reportsAvailable
            ? artifacts
            : withoutReports(artifacts),
          diagnostic: finished.diagnostic ?? diagnostic,
          reporterFailed: true,
        };
      } catch (error) {
        await writer.invalidate();
        await reportWriter?.invalidate();
        const output = outputDiagnostic(
          error instanceof ProgressWriterError ? error.path : writer.resultPath,
        );
        return {
          result: terminalOutputFailure(result, output),
          artifacts: { ...artifacts, authoritative: false },
          diagnostic: output,
          reporterFailed: true,
        };
      }
    };
    try {
      await recorder.start();
    } catch (error) {
      if (error instanceof ReporterOutputError) return onReporterFailure();
      commit();
      const diagnostic = outputDiagnostic(writer.progressPath);
      await writer.invalidate();
      return {
        result: await resultWithoutSink(runId, diagnostic),
        artifacts: { ...artifacts, authoritative: false },
        diagnostic,
      };
    }
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
          false,
        );
      } catch {
        const diagnostic = outputDiagnostic(
          path.join(config.reporterDir, runId, "result.json"),
        );
        commit();
        await recorder.finish(canonicalDiagnosticError(diagnostic));
        const finished = await finishCanonical(writer, recorder.snapshot);
        return {
          result: finished.result,
          artifacts: finished.reportsAvailable
            ? artifacts
            : withoutReports(artifacts),
          diagnostic: finished.diagnostic ?? diagnostic,
        };
      }
    }
    const reportedArtifacts: RunArtifactPaths = requestedJsonReport
      ? {
          ...artifacts,
          reporterPath: reportWriter?.resultPath ?? writer.resultPath,
        }
      : artifacts;
    const finishArtifacts = async (): Promise<
      FinalReportWrite & { reporterAvailable: boolean }
    > => {
      let reporterAvailable = true;
      let reporterDiagnostic: CliDiagnostic | null = null;
      if (reportWriter) {
        try {
          await reportWriter.finish(recorder.snapshot);
        } catch {
          reporterDiagnostic = outputDiagnostic(reportWriter.resultPath);
          reporterAvailable = false;
          await reportWriter.invalidate();
          if (recorder.snapshot.error === null)
            await recorder.finish(canonicalDiagnosticError(reporterDiagnostic));
        }
      }
      const finished = await finishCanonical(writer, recorder.snapshot);
      if (finished.diagnostic && reportWriter && reporterAvailable) {
        try {
          await reportWriter.finish(finished.result);
        } catch {
          reporterAvailable = false;
          await reportWriter.invalidate();
        }
      }
      return {
        ...finished,
        diagnostic: finished.diagnostic ?? reporterDiagnostic,
        reporterAvailable,
      };
    };
    const terminalExecution = async (
      diagnostic: CliDiagnostic | null,
    ): Promise<RunCommandExecution> => {
      try {
        const finished = await finishArtifacts();
        const availableArtifacts = finished.reporterAvailable
          ? reportedArtifacts
          : artifacts;
        return {
          result: finished.result,
          artifacts: finished.reportsAvailable
            ? availableArtifacts
            : withoutReports(availableArtifacts),
          diagnostic: finished.diagnostic ?? diagnostic,
          reporterFailed,
          onReporterFailure,
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
    let globalSelectedTests = 0;
    let discoveryProblems: NonNullable<RunResult["discoveryProblems"]> = [];
    try {
      const selection = await discoverRunTests(
        config,
        options.paths ?? (options.file ? [options.file] : []),
        options.filters,
      );
      globalSelectedTests = selection.tests.length;
      const selected = options.shard
        ? shardTests(selection.tests, options.shard)
        : selection.tests;
      files = selected.map((test) => path.join(config.projectRoot, test.file));
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
      // Each bad file is reported by exactly one shard.
      if (options.shard)
        discoveryProblems = shardProblems(discoveryProblems, options.shard);
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
    if (files.length === 0 && options.shard && globalSelectedTests > 0) {
      const { index, count } = options.shard;
      const diagnostic: CliDiagnostic = {
        code: "empty_shard",
        message: `Shard ${index}/${count} has no tests; the selection has ${globalSelectedTests} test${globalSelectedTests === 1 ? "" : "s"}.`,
        fix: `Use --shard-count ${globalSelectedTests} or fewer.`,
      };
      if (discoveryProblems.length)
        await recorder.addDiscoveryProblems(discoveryProblems);
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
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
      const lanes = planLanes(
        options.parallel ?? 1,
        options.availableParallelism ?? availableParallelism(),
        files.length,
      );
      const providerConcurrency =
        options.providerConcurrency ??
        Math.min(DEFAULT_PROVIDER_CONCURRENCY, lanes * 2);
      await recorder.selectTests(files.length, {
        parallel: { requested: options.parallel ?? 1, lanes },
        shard: options.shard ? { ...options.shard, globalSelectedTests } : null,
        providerConcurrency,
      });
      if (discoveryProblems.length)
        await recorder.addDiscoveryProblems(discoveryProblems);
      if (signal.aborted) throw new Error("canceled");
      const gate = new ProviderGate({ concurrency: providerConcurrency });
      const provider = new TypeSafeAdapter({
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        gate,
      });
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
      const driver = new PlaywrightBrowserDriver();
      const browsers = Array.from(
        { length: lanes },
        () => new ReusableBrowserDriver(driver),
      );
      try {
        await runPool({
          items: files,
          lanes,
          signal,
          run: async (file, lane, ordinal) => {
            const browser = browsers[lane]!;
            for (
              let attempt = 0;
              attempt <= (options.retries ?? 0);
              attempt++
            ) {
              if (attempt > 0)
                await recorder.testAt(ordinal)?.startAttempt(lane);
              const result = await runFlow(file, {
                repoRoot: config.projectRoot,
                browser,
                provider,
                classificationCache: cache,
                locatorCache,
                // Per-attempt values let tests keep backend data apart, like
                // Playwright's TEST_PARALLEL_INDEX. They are env-derived, so
                // they stay opaque in model input and reports.
                env: {
                  ...config.variables,
                  SEDUM_PARALLEL_INDEX: String(lane),
                  SEDUM_SHARD_INDEX: String(options.shard?.index ?? 1),
                  SEDUM_ATTEMPT_KEY: randomBytes(6).toString("hex"),
                },
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
                  slot: { ordinal, lane },
                  privacy: {
                    secretValues: [],
                    sensitiveOrigins: options.sensitiveOrigins,
                  },
                  evidenceEnabled: options.evidence,
                  replay: options.replay,
                  saveFrame: (attempt, frameId, bytes) =>
                    writer.saveFrame(attempt, frameId, bytes),
                },
              });
              if (reporterFailed) throw new ReporterOutputError();
              if (signal.aborted) return "stop";
              if (result.status === "could_not_run") {
                // Replace the lane's browser, as Playwright replaces a worker.
                await browser.recycle();
                operational ??= flowDiagnostic(result);
                return "stop";
              }
              if (result.status === "passed") break;
            }
            return "continue";
          },
        });
      } finally {
        gate.close();
        await Promise.all(browsers.map((browser) => browser.recycle()));
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
      if (error instanceof ReporterOutputError) {
        commit();
        return onReporterFailure();
      }
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
