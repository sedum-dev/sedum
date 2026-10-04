import {
  type RunRecorder,
  type RunResult,
  RejectionRouter,
  type VisionKeyProbe,
} from "@sedum-dev/core";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalDiagnosticError,
  outputDiagnostic,
  setupDiagnostic,
  type CliDiagnostic,
} from "./diagnostics.js";
import { ProgressWriterError } from "./progress-writer.js";
import type { RunArtifactPaths } from "./output.js";
import { ProjectConfigError, type ResolvedProjectConfig } from "./config.js";
import type { RunFilters } from "./run-selection.js";
import type { ParallelRequest } from "./run-pool.js";
import type { ShardSpec } from "./run-shard.js";
import {
  ReporterOutputError,
  preExecutionFailure,
  reportSelection,
  terminalOutputFailure,
} from "./run-command-output.js";
import { resolveRunConfig } from "./run-command-setup.js";
import { discoverCommandTests } from "./run-command-discovery.js";
import { executeSelectedTests } from "./run-command-tests.js";
import {
  safeDiscoveryText,
  strayRejectionDiagnostic,
} from "./run-command-support.js";
import { openRunSession } from "./run-command-session.js";
import {
  completedRunConclusion,
  interruptionConclusion,
  selectionConclusion,
  type RunConclusion,
} from "./run-command-outcome.js";

export {
  verifyGraceMs,
  strayRejectionDiagnostic,
} from "./run-command-support.js";

export interface RunCommandOptions {
  /**
   * Receives a stray rejection from test code that arrived after the run was
   * reported; the `sedum` binary prints it and fails the exit code.
   */
  readonly onStrayRejection?: (message: string) => void;
  readonly file?: string;
  readonly paths?: readonly string[];
  readonly filters?: RunFilters;
  readonly environment?: string;
  readonly browser?: string;
  readonly vision?: boolean;
  readonly visionModel?: string;
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
  /** Injected for tests; defaults to OpenRouter's unbilled key endpoint. */
  readonly probeVisionKey?: (apiKey: string) => Promise<VisionKeyProbe>;
  readonly replay: boolean;
  readonly evidence: boolean;
  readonly sensitiveOrigins: readonly string[];
  readonly locatorCacheDisabled?: boolean;
  readonly locatorCacheCi?: boolean;
  readonly signal?: AbortSignal;
  /** How to invoke sedum in report rerun hints, e.g. `npx sedum`. */
  readonly command?: string;
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

const SUPPORTED_REPORTERS: readonly string[] = [
  "terminal",
  "json",
  "list",
  "steps",
  "markdown",
  "junit",
];

async function finishConclusion(request: {
  readonly conclusion: RunConclusion;
  readonly discoveryProblems: NonNullable<RunResult["discoveryProblems"]>;
  readonly recorder: RunRecorder;
  readonly commit: () => void;
  readonly terminalExecution: (
    diagnostic: CliDiagnostic | null,
  ) => Promise<RunCommandExecution>;
}): Promise<RunCommandExecution> {
  const { conclusion, discoveryProblems, recorder, commit, terminalExecution } =
    request;
  if (conclusion.recordDiscoveryProblems)
    await recorder.addDiscoveryProblems(discoveryProblems);
  commit();
  await recorder.finish(
    canonicalDiagnosticError(conclusion.diagnostic),
    conclusion.state,
  );
  return terminalExecution(conclusion.diagnostic);
}

export async function executeRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  const invocationRoot = process.cwd();
  // Removed only when the command ends, so a stray rejection from test code
  // during reporting is still caught. After that, the `sedum` binary's
  // fallback reports it.
  let rejections: RejectionRouter | undefined;
  let strayConfig: ResolvedProjectConfig | undefined;
  let reportedStrays = 0;
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
    config = await resolveRunConfig(invocationRoot, options);
  } catch (error) {
    const diagnostic = setupDiagnostic(error);
    const fallbackRoot =
      error instanceof ProjectConfigError && error.diagnostics[0]?.file
        ? path.dirname(error.diagnostics[0].file)
        : invocationRoot;
    return preExecutionFailure({
      root: fallbackRoot,
      runId,
      outputDir: undefined,
      reporterDir: options.reporterDir
        ? path.resolve(fallbackRoot, options.reporterDir)
        : path.join(fallbackRoot, ".sedum", "reports"),
      selection: reportFiles,
      strict: options.strict ?? false,
      diagnostic,
      commit,
    });
  }

  const unavailable = (options.reporters ?? []).find(
    (reporter) => !SUPPORTED_REPORTERS.includes(reporter),
  );
  if (unavailable)
    return preExecutionFailure({
      root: config.projectRoot,
      runId,
      outputDir: config.outputDir,
      reporterDir: config.reporterDir,
      selection: reportFiles,
      strict: options.strict ?? false,
      diagnostic: {
        code: "unsupported_reporter",
        message: `Reporter ${JSON.stringify(unavailable)} is not available in this build.`,
        fix: "Use --reporter list, steps, terminal, json, markdown, or junit.",
      },
      commit,
    });
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
    const opened = await openRunSession({
      config,
      runId,
      options,
      reports: reportFiles,
      commit,
    });
    if (opened.execution) return opened.execution;
    const session = opened.session;
    const startFailure = await session.start();
    if (startFailure) return startFailure;
    const copyFailure = await session.openReportCopy();
    if (copyFailure) return copyFailure;
    const { recorder, writer } = session;
    const terminalExecution = (diagnostic: CliDiagnostic | null) =>
      session.terminalExecution(diagnostic);
    let files: readonly { readonly file: string; readonly id: string }[];
    let globalSelectedTests = 0;
    let discoveryProblems: NonNullable<RunResult["discoveryProblems"]> = [];
    // Before any test file is imported: a rejection from a file's top-level
    // code is then reported for the run rather than lost. Installed after the
    // setup checks, so every path from here reaches the disposing finally.
    strayConfig = config;
    rejections = new RejectionRouter(config.projectRoot);
    rejections.install();
    try {
      const discovery = await discoverCommandTests(config, options, (value) =>
        safeDiscoveryText(value, config),
      );
      files = discovery.files;
      globalSelectedTests = discovery.globalSelectedTests;
      discoveryProblems = discovery.problems;
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
    const selectionFailure = selectionConclusion({
      config,
      options,
      files,
      globalSelectedTests,
      problems: discoveryProblems,
      aborted: signal.aborted,
      timedOut,
    });
    if (selectionFailure)
      return finishConclusion({
        conclusion: selectionFailure,
        discoveryProblems,
        recorder,
        commit,
        terminalExecution,
      });

    try {
      const router = rejections!;
      const { operational: executedOperational, erroredTests } =
        await executeSelectedTests({
          config,
          options,
          files,
          globalSelectedTests,
          discoveryProblems,
          signal,
          recorder,
          writer,
          rejections: router,
          reporterFailed: () => session.reporterFailed,
        });
      let operational = executedOperational;
      // A rejection no running test owned fails the run with its location,
      // instead of crashing it or failing an unrelated test.
      // With another run error already primary, the strays still reach the
      // terminal through onStrayRejection rather than being dropped.
      if (router.unattributed.length && !operational) {
        reportedStrays = router.unattributed.length;
        operational = strayRejectionDiagnostic(router.unattributed, config);
      }
      if (signal.aborted)
        return finishConclusion({
          conclusion: interruptionConclusion(timedOut),
          discoveryProblems,
          recorder,
          commit,
          terminalExecution,
        });
      const diagnostic = completedRunConclusion(
        operational,
        erroredTests,
        discoveryProblems,
      );
      commit();
      if (diagnostic)
        await recorder.finish(canonicalDiagnosticError(diagnostic));
      else await recorder.finish();
      return terminalExecution(diagnostic);
    } catch (error) {
      if (error instanceof ReporterOutputError) {
        commit();
        return session.reporterFailure();
      }
      if (error instanceof ProgressWriterError) {
        commit();
        const diagnostic = outputDiagnostic(error.path);
        const result = terminalOutputFailure(recorder.snapshot, diagnostic);
        await writer.invalidate();
        return {
          result,
          artifacts: { ...session.artifacts, authoritative: false },
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
        : setupDiagnostic(error, config.providerName);
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
          artifacts: { ...session.artifacts, authoritative: false },
          diagnostic: output,
        };
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
    rejections?.dispose();
    // Anything that arrived after the report was decided goes to the caller.
    for (const late of rejections?.unattributed.slice(reportedStrays) ?? [])
      options.onStrayRejection?.(
        strayRejectionDiagnostic([late], strayConfig!).message,
      );
  }
}
