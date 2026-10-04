import {
  RejectionRouter,
  type RunRecorder,
  type RunResult,
} from "@sedum-dev/core";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ProjectConfigError, type ResolvedProjectConfig } from "./config.js";
import {
  canonicalDiagnosticError,
  outputDiagnostic,
  setupDiagnostic,
  type CliDiagnostic,
} from "./diagnostics.js";
import type { RunCommandExecution, RunCommandOptions } from "./run-command.js";
import {
  discoverCommandTests,
  type RunDiscovery,
} from "./run-command-discovery.js";
import {
  completedRunConclusion,
  interruptionConclusion,
  selectionConclusion,
  type RunConclusion,
} from "./run-command-outcome.js";
import {
  ReporterOutputError,
  preExecutionFailure,
  reportSelection,
  terminalOutputFailure,
  type ReportSelection,
} from "./run-command-output.js";
import {
  openRunSession,
  type RunOutputSession,
} from "./run-command-session.js";
import { resolveRunConfig } from "./run-command-setup.js";
import {
  safeDiscoveryText,
  strayRejectionDiagnostic,
} from "./run-command-support.js";
import { executeSelectedTests } from "./run-command-tests.js";
import { ProgressWriterError } from "./progress-writer.js";

const SUPPORTED_REPORTERS: readonly string[] = [
  "terminal",
  "json",
  "list",
  "steps",
  "markdown",
  "junit",
];

interface CommandContext {
  readonly options: RunCommandOptions;
  readonly invocationRoot: string;
  readonly reports: ReportSelection;
  readonly runId: string;
  readonly commit: () => void;
  rejections?: RejectionRouter;
  config?: ResolvedProjectConfig;
  reportedStrays: number;
}

type PreparedRun =
  | { readonly config: ResolvedProjectConfig; readonly execution?: never }
  | { readonly config?: never; readonly execution: RunCommandExecution };

type DiscoveredRun =
  | { readonly discovery: RunDiscovery; readonly execution?: never }
  | { readonly discovery?: never; readonly execution: RunCommandExecution };

interface RunExecutionContext {
  readonly command: CommandContext;
  readonly config: ResolvedProjectConfig;
  readonly deadline: RunDeadline;
  readonly session: RunOutputSession;
}

export async function executeRunCommandImplementation(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  const context = commandContext(options);
  const prepared = await prepareRun(context);
  if (prepared.execution) return prepared.execution;
  const deadline = new RunDeadline(options);
  try {
    return await executeConfiguredRun(context, prepared.config, deadline);
  } finally {
    deadline.dispose();
    disposeRejections(context);
  }
}

function commandContext(options: RunCommandOptions): CommandContext {
  let committed = false;
  return {
    options,
    invocationRoot: process.cwd(),
    reports: reportSelection(options),
    runId: randomUUID(),
    reportedStrays: 0,
    commit: () => {
      if (committed) return;
      committed = true;
      options.onCommitted?.();
    },
  };
}

async function prepareRun(context: CommandContext): Promise<PreparedRun> {
  let config: ResolvedProjectConfig;
  try {
    config = await resolveRunConfig(context.invocationRoot, context.options);
  } catch (error) {
    return { execution: await setupFailure(context, error) };
  }
  const unavailable = unsupportedReporter(context.options.reporters);
  if (!unavailable) return { config };
  return {
    execution: await preExecutionFailure({
      root: config.projectRoot,
      runId: context.runId,
      outputDir: config.outputDir,
      reporterDir: config.reporterDir,
      selection: context.reports,
      strict: context.options.strict ?? false,
      diagnostic: {
        code: "unsupported_reporter",
        message: `Reporter ${JSON.stringify(unavailable)} is not available in this build.`,
        fix: "Use --reporter list, steps, terminal, json, markdown, or junit.",
      },
      commit: context.commit,
    }),
  };
}

function unsupportedReporter(
  reporters?: readonly string[],
): string | undefined {
  return (reporters ?? []).find(
    (reporter) => !SUPPORTED_REPORTERS.includes(reporter),
  );
}

async function setupFailure(
  context: CommandContext,
  error: unknown,
): Promise<RunCommandExecution> {
  const diagnostic = setupDiagnostic(error);
  const root = fallbackRoot(context.invocationRoot, error);
  return preExecutionFailure({
    root,
    runId: context.runId,
    outputDir: undefined,
    reporterDir: context.options.reporterDir
      ? path.resolve(root, context.options.reporterDir)
      : path.join(root, ".sedum", "reports"),
    selection: context.reports,
    strict: context.options.strict ?? false,
    diagnostic,
    commit: context.commit,
  });
}

function fallbackRoot(invocationRoot: string, error: unknown): string {
  if (!(error instanceof ProjectConfigError)) return invocationRoot;
  const file = error.diagnostics[0]?.file;
  return file ? path.dirname(file) : invocationRoot;
}

class RunDeadline {
  readonly controller = new AbortController();
  private timeout: ReturnType<typeof setTimeout> | undefined;
  timedOut = false;

  constructor(private readonly options: RunCommandOptions) {
    if (options.signal?.aborted) this.abortFromExternal();
    else
      options.signal?.addEventListener("abort", this.abortFromExternal, {
        once: true,
      });
    if (options.timeoutMinutes !== undefined)
      this.timeout = setTimeout(
        () => this.expire(),
        options.timeoutMinutes * 60_000,
      );
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.options.signal?.removeEventListener("abort", this.abortFromExternal);
  }

  private readonly abortFromExternal = () => {
    this.controller.abort(this.options.signal?.reason);
  };

  private expire(): void {
    if (this.signal.aborted) return;
    this.timedOut = true;
    this.controller.abort(new Error("run_timeout"));
    this.options.onDeadline?.();
  }
}

async function executeConfiguredRun(
  context: CommandContext,
  config: ResolvedProjectConfig,
  deadline: RunDeadline,
): Promise<RunCommandExecution> {
  const opened = await openRunSession({
    config,
    runId: context.runId,
    options: context.options,
    reports: context.reports,
    commit: context.commit,
  });
  if (opened.execution) return opened.execution;
  const startFailure = await opened.session.start();
  if (startFailure) return startFailure;
  const copyFailure = await opened.session.openReportCopy();
  if (copyFailure) return copyFailure;
  return executeOpenSession(context, config, deadline, opened.session);
}

async function executeOpenSession(
  context: CommandContext,
  config: ResolvedProjectConfig,
  deadline: RunDeadline,
  session: RunOutputSession,
): Promise<RunCommandExecution> {
  const execution = { command: context, config, deadline, session };
  context.config = config;
  context.rejections = new RejectionRouter(config.projectRoot);
  context.rejections.install();
  const discovered = await discoverRun(context, config, session);
  if (discovered.execution) return discovered.execution;
  const selectionFailure = selectionConclusion({
    config,
    options: context.options,
    files: discovered.discovery.files,
    globalSelectedTests: discovered.discovery.globalSelectedTests,
    problems: discovered.discovery.problems,
    aborted: deadline.signal.aborted,
    timedOut: deadline.timedOut,
  });
  if (selectionFailure)
    return finishConclusion(
      context,
      session,
      discovered.discovery.problems,
      selectionFailure,
    );
  return executeDiscoveredRun(execution, discovered.discovery);
}

async function discoverRun(
  context: CommandContext,
  config: ResolvedProjectConfig,
  session: RunOutputSession,
): Promise<DiscoveredRun> {
  try {
    return {
      discovery: await discoverCommandTests(config, context.options, (value) =>
        safeDiscoveryText(value, config),
      ),
    };
  } catch {
    const diagnostic = discoveryDiagnostic(config);
    context.commit();
    await session.recorder.finish(canonicalDiagnosticError(diagnostic));
    return { execution: await session.terminalExecution(diagnostic) };
  }
}

function discoveryDiagnostic(config: ResolvedProjectConfig): CliDiagnostic {
  return setupDiagnostic(
    new ProjectConfigError([
      {
        code: "test_discovery_error",
        file: config.configPath ?? config.testDirectory,
        line: 1,
        col: 1,
        key: "tests.directory",
        message: "The configured test directory could not be read.",
        fix: "Check the test directory path and permissions, then try again.",
      },
    ]),
  );
}

async function finishConclusion(
  context: CommandContext,
  session: RunOutputSession,
  problems: NonNullable<RunResult["discoveryProblems"]>,
  conclusion: RunConclusion,
): Promise<RunCommandExecution> {
  if (conclusion.recordDiscoveryProblems)
    await session.recorder.addDiscoveryProblems(problems);
  context.commit();
  await session.recorder.finish(
    canonicalDiagnosticError(conclusion.diagnostic),
    conclusion.state,
  );
  return session.terminalExecution(conclusion.diagnostic);
}

async function executeDiscoveredRun(
  execution: RunExecutionContext,
  discovery: RunDiscovery,
): Promise<RunCommandExecution> {
  try {
    return await runSelected(execution, discovery);
  } catch (error) {
    return handleRunError(execution, error);
  }
}

async function runSelected(
  execution: RunExecutionContext,
  discovery: RunDiscovery,
): Promise<RunCommandExecution> {
  const { command: context, config, deadline, session } = execution;
  const router = context.rejections!;
  const outcome = await executeSelectedTests({
    config,
    options: context.options,
    files: discovery.files,
    globalSelectedTests: discovery.globalSelectedTests,
    discoveryProblems: discovery.problems,
    signal: deadline.signal,
    recorder: session.recorder,
    writer: session.writer,
    rejections: router,
    reporterFailed: () => session.reporterFailed,
  });
  const operational = includeStrayRejections(
    context,
    config,
    outcome.operational,
  );
  if (deadline.signal.aborted)
    return finishConclusion(
      context,
      session,
      discovery.problems,
      interruptionConclusion(deadline.timedOut),
    );
  const diagnostic = completedRunConclusion(
    operational,
    outcome.erroredTests,
    discovery.problems,
  );
  context.commit();
  await finishRecorder(session.recorder, diagnostic);
  return session.terminalExecution(diagnostic);
}

function includeStrayRejections(
  context: CommandContext,
  config: ResolvedProjectConfig,
  operational: CliDiagnostic | null,
): CliDiagnostic | null {
  if (operational) return operational;
  const strays = context.rejections!.unattributed;
  if (strays.length === 0) return null;
  context.reportedStrays = strays.length;
  return strayRejectionDiagnostic(strays, config);
}

async function finishRecorder(
  recorder: RunRecorder,
  diagnostic: CliDiagnostic | null,
): Promise<void> {
  if (diagnostic) await recorder.finish(canonicalDiagnosticError(diagnostic));
  else await recorder.finish();
}

async function handleRunError(
  execution: RunExecutionContext,
  error: unknown,
): Promise<RunCommandExecution> {
  const { command: context, config, deadline, session } = execution;
  context.commit();
  if (error instanceof ReporterOutputError) return session.reporterFailure();
  if (error instanceof ProgressWriterError)
    return progressWriteFailure(session, error);
  const diagnostic = deadline.signal.aborted
    ? interruptionConclusion(deadline.timedOut).diagnostic
    : setupDiagnostic(error, config.providerName);
  return finishUnexpectedError(session, deadline, diagnostic);
}

async function progressWriteFailure(
  session: RunOutputSession,
  error: ProgressWriterError,
): Promise<RunCommandExecution> {
  const diagnostic = outputDiagnostic(error.path);
  const result = terminalOutputFailure(session.recorder.snapshot, diagnostic);
  await session.writer.invalidate();
  return {
    result,
    artifacts: { ...session.artifacts, authoritative: false },
    diagnostic,
  };
}

async function finishUnexpectedError(
  session: RunOutputSession,
  deadline: RunDeadline,
  diagnostic: CliDiagnostic,
): Promise<RunCommandExecution> {
  try {
    if (session.recorder.snapshot.state === "running")
      await session.recorder.finish(
        canonicalDiagnosticError(diagnostic),
        failureState(deadline),
      );
    return session.terminalExecution(diagnostic);
  } catch (error) {
    return finalWriteFailure(session, error);
  }
}

function failureState(deadline: RunDeadline): "interrupted" | "error" {
  if (!deadline.signal.aborted) return "error";
  return deadline.timedOut ? "error" : "interrupted";
}

async function finalWriteFailure(
  session: RunOutputSession,
  error: unknown,
): Promise<RunCommandExecution> {
  const output = outputDiagnostic(
    error instanceof ProgressWriterError
      ? error.path
      : session.writer.resultPath,
  );
  const result = terminalOutputFailure(session.recorder.snapshot, output);
  await session.writer.invalidate();
  return {
    result,
    artifacts: { ...session.artifacts, authoritative: false },
    diagnostic: output,
  };
}

function disposeRejections(context: CommandContext): void {
  context.rejections?.dispose();
  const late =
    context.rejections?.unattributed.slice(context.reportedStrays) ?? [];
  if (!context.config) return;
  for (const stray of late)
    context.options.onStrayRejection?.(
      strayRejectionDiagnostic([stray], context.config).message,
    );
}
