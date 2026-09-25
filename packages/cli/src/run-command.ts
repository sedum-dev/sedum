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
import { junitEvidenceDirectory } from "./evidence-root.js";
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
  /** SED-13 strict gate; JUnit records it so the file matches the exit. */
  readonly strict?: boolean;
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

const SUPPORTED_REPORTERS: readonly string[] = [
  "terminal",
  "json",
  "list",
  "steps",
  "markdown",
  "junit",
];

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
  keepExisting = false,
): RunResult {
  // A run that already ended with its own error keeps it primary.
  if (keepExisting && source.error !== null && source.state !== "running")
    return source;
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

/** Which files the selected reporters ask for, beyond the terminal. */
interface ReportSelection {
  /** The JSON copy under the reporter directory. */
  readonly json: boolean;
  readonly markdown: boolean;
  readonly junit: boolean;
}

function reportSelection(options: RunCommandOptions): ReportSelection {
  const reporters = options.reporters ?? [];
  return {
    json: Boolean(options.reporterDir) || reporters.includes("json"),
    markdown: reporters.includes("markdown"),
    junit: reporters.includes("junit"),
  };
}

/**
 * The reporter-directory writer: the JSON copy and `junit.xml`. When the
 * reporter directory is the output directory, JUnit goes to the canonical
 * writer and the canonical `result.json` is the JSON report.
 */
async function openReportCopy(
  root: string,
  runId: string,
  canonical: ProgressWriter,
  outputDir: string,
  reporterDir: string,
  selection: ReportSelection,
  strict: boolean,
): Promise<ProgressWriter | undefined> {
  const junit = selection.junit
    ? {
        strict,
        evidenceDirectory: await junitEvidenceDirectory(
          canonical.directory,
          root,
          process.env,
        ),
      }
    : null;
  if (path.resolve(reporterDir) === path.resolve(outputDir)) {
    if (junit) canonical.includeJunit(junit);
    return undefined;
  }
  if (!selection.json && !junit) return undefined;
  return ProgressWriter.create(root, runId, reporterDir, {
    json: selection.json,
    html: false,
    junit,
  });
}

interface RunFinish {
  readonly result: RunResult;
  readonly diagnostic: CliDiagnostic | null;
  readonly reportsAvailable: boolean;
  readonly copyAvailable: boolean;
}

function reportFormat(target: string): string {
  const name = path.basename(target);
  return name === "report.html"
    ? "HTML"
    : name === "report.md"
      ? "Markdown"
      : "JUnit";
}

/**
 * Write every run file from one final result, in an order where no file can
 * claim a result the others contradict:
 *
 * 1. The reporter-directory JSON copy. A failure is recorded in the result
 *    (`output_error`) before any canonical file exists, and the copy
 *    directory is not touched again.
 * 2. The canonical `result.json`, then its reports.
 * 3. The reporter-directory `junit.xml`.
 *
 * When a rendered report fails, every rendered report is removed and the JSON
 * is rewritten with `reporter_output_error` (an earlier run error stays
 * primary). Only a failed canonical `result.json` escapes to the caller.
 */
async function finishRun(
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  result: RunResult,
  recordCopyFailure: (diagnostic: CliDiagnostic) => Promise<RunResult>,
): Promise<RunFinish> {
  let current = result;
  let diagnostic: CliDiagnostic | null = null;
  let copyAvailable = copy !== undefined;
  if (copy?.includesJson) {
    try {
      await copy.finish(current, { reports: false });
    } catch {
      diagnostic = outputDiagnostic(copy.resultPath);
      copyAvailable = false;
      await copy.invalidate().catch(() => undefined);
      current = await recordCopyFailure(diagnostic);
    }
  }
  try {
    await canonical.finish(current);
    if (copy && copyAvailable && copy.includesJunit)
      await copy.finish(current, { json: false });
    return {
      result: current,
      diagnostic,
      reportsAvailable: true,
      copyAvailable,
    };
  } catch (error) {
    if (
      !(error instanceof ProgressWriterError) ||
      !(
        canonical.isReport(error.path) ||
        (copy && copyAvailable && copy.isReport(error.path))
      )
    )
      throw error;
    const failure: CliDiagnostic = {
      code: "reporter_output_error",
      message: `The ${reportFormat(error.path)} report could not be written to ${error.path}.`,
      fix: "Check the run output directory and rerun the command.",
    };
    const failed = terminalOutputFailure(current, failure, true);
    await canonical.removeReports();
    if (copy && copyAvailable)
      try {
        await copy.removeReports();
        if (copy.includesJson) await copy.finish(failed, { reports: false });
      } catch {
        // A broken copy directory never costs the canonical output.
        copyAvailable = false;
        await copy.invalidate().catch(() => undefined);
      }
    await canonical.finish(failed, { reports: false });
    return {
      result: failed,
      diagnostic: failure,
      reportsAvailable: false,
      copyAvailable,
    };
  }
}

/** The files a finished run can point to, leaving out any that failed. */
function finishedArtifacts(
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  selection: ReportSelection,
  finished: RunFinish,
): RunArtifactPaths {
  const junit = canonical.includesJunit
    ? canonical
    : copy?.includesJunit && finished.copyAvailable
      ? copy
      : undefined;
  const json = copy?.includesJson
    ? finished.copyAvailable
      ? copy
      : undefined
    : canonical;
  return {
    progressPath: canonical.progressPath,
    resultPath: canonical.resultPath,
    ...(finished.reportsAvailable
      ? {
          htmlPath: canonical.htmlPath,
          ...(canonical.includeMarkdown
            ? { markdownPath: canonical.markdownPath }
            : {}),
          ...(junit ? { junitPath: junit.junitPath } : {}),
        }
      : {}),
    ...(selection.json && json ? { reporterPath: json.resultPath } : {}),
    authoritative: true,
  };
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

/**
 * A run that ends before executing anything still leaves every requested
 * file, so CI finds a `junit.xml` whose run suite carries the error.
 */
async function preExecutionFailure(
  root: string,
  runId: string,
  outputDir: string | undefined,
  reporterDir: string,
  selection: ReportSelection,
  strict: boolean,
  diagnostic: CliDiagnostic,
  commit: () => void,
): Promise<RunCommandExecution> {
  const base = outputDir ?? path.join(root, ".sedum", "runs");
  const intended = path.join(base, runId);
  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(root, runId, base, {
      markdown: selection.markdown,
    });
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
  const copy = await openReportCopy(
    root,
    runId,
    writer,
    base,
    reporterDir,
    selection,
    strict,
  ).catch(() => undefined);
  const recorder = new RunRecorder((snapshot) => writer.write(snapshot), runId);
  try {
    await recorder.start();
    commit();
    await recorder.finish(canonicalDiagnosticError(diagnostic));
    const finished = await finishRun(
      writer,
      copy,
      recorder.snapshot,
      async () => recorder.snapshot,
    );
    return {
      result: finished.result,
      artifacts: finishedArtifacts(writer, copy, selection, finished),
      diagnostic: finished.diagnostic ?? diagnostic,
    };
  } catch {
    commit();
    await writer.invalidate();
    await copy?.invalidate();
    return {
      result: await resultWithoutSink(runId, diagnostic),
      artifacts: {
        progressPath: writer.progressPath,
        resultPath: writer.resultPath,
        authoritative: false,
      },
      diagnostic,
    };
  }
}

export async function executeRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  const invocationRoot = process.cwd();
  const reportFiles = reportSelection(options);
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
    return preExecutionFailure(
      fallbackRoot,
      runId,
      undefined,
      options.reporterDir
        ? path.resolve(fallbackRoot, options.reporterDir)
        : path.join(fallbackRoot, ".sedum", "reports"),
      reportFiles,
      options.strict ?? false,
      diagnostic,
      commit,
    );
  }

  const unavailable = (options.reporters ?? []).find(
    (reporter) => !SUPPORTED_REPORTERS.includes(reporter),
  );
  if (unavailable)
    return preExecutionFailure(
      config.projectRoot,
      runId,
      config.outputDir,
      config.reporterDir,
      reportFiles,
      options.strict ?? false,
      {
        code: "unsupported_reporter",
        message: `Reporter ${JSON.stringify(unavailable)} is not available in this build.`,
        fix: "Use --reporter list, steps, terminal, json, markdown, or junit.",
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
        { markdown: reportFiles.markdown },
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
    // Paths the live reporters may name; the finished run reports its own.
    let artifacts: RunArtifactPaths = {
      progressPath: writer.progressPath,
      resultPath: writer.resultPath,
      htmlPath: writer.htmlPath,
      ...(reportFiles.markdown ? { markdownPath: writer.markdownPath } : {}),
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
    const recordCopyFailure = async (
      diagnostic: CliDiagnostic,
    ): Promise<RunResult> => {
      if (recorder.snapshot.error === null)
        await recorder.finish(canonicalDiagnosticError(diagnostic));
      return recorder.snapshot;
    };
    const onReporterFailure = async (): Promise<RunCommandExecution> => {
      const diagnostic: CliDiagnostic = {
        code: "reporter_output_error",
        message: "The selected reporter could not write output.",
        fix: "Check terminal output access and rerun the command.",
      };
      const result = terminalOutputFailure(recorder.snapshot, diagnostic);
      try {
        const finished = await finishRun(
          writer,
          reportWriter,
          result,
          async () => result,
        );
        return {
          result: finished.result,
          artifacts: finishedArtifacts(
            writer,
            reportWriter,
            reportFiles,
            finished,
          ),
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
    try {
      reportWriter = await openReportCopy(
        config.projectRoot,
        runId,
        writer,
        config.outputDir,
        config.reporterDir,
        reportFiles,
        options.strict ?? false,
      );
    } catch {
      const diagnostic = outputDiagnostic(
        path.join(config.reporterDir, runId, "result.json"),
      );
      commit();
      await recorder.finish(canonicalDiagnosticError(diagnostic));
      const finished = await finishRun(
        writer,
        undefined,
        recorder.snapshot,
        async () => recorder.snapshot,
      );
      return {
        result: finished.result,
        artifacts: finishedArtifacts(writer, undefined, reportFiles, {
          ...finished,
          copyAvailable: false,
        }),
        diagnostic: finished.diagnostic ?? diagnostic,
      };
    }
    const junitWriter = writer.includesJunit
      ? writer
      : reportWriter?.includesJunit
        ? reportWriter
        : undefined;
    if (junitWriter)
      artifacts = { ...artifacts, junitPath: junitWriter.junitPath };
    const terminalExecution = async (
      diagnostic: CliDiagnostic | null,
    ): Promise<RunCommandExecution> => {
      try {
        const finished = await finishRun(
          writer,
          reportWriter,
          recorder.snapshot,
          recordCopyFailure,
        );
        return {
          result: finished.result,
          artifacts: finishedArtifacts(
            writer,
            reportWriter,
            reportFiles,
            finished,
          ),
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
        baseURL: config.providerBaseUrl,
        model: config.providerModel,
        gate,
      });
      const cache = await FileClassificationCache.load(
        path.join(config.projectRoot, ".sedum", "classifications.json"),
        config.providerModel,
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
