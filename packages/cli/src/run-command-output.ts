import {
  RunRecorder,
  validateRunResult,
  type RunResult,
} from "@sedum-dev/core";
import path from "node:path";
import {
  canonicalDiagnosticError,
  outputDiagnostic,
  type CliDiagnostic,
} from "./diagnostics.js";
import { junitEvidenceDirectory } from "./evidence-root.js";
import type { RunArtifactPaths } from "./output.js";
import { ProgressWriter, ProgressWriterError } from "./progress-writer.js";
import type { RunCommandExecution, RunCommandOptions } from "./run-command.js";

export class ReporterOutputError extends Error {}

/** Which files the selected reporters ask for, beyond the terminal. */
export interface ReportSelection {
  /** The JSON copy under the reporter directory. */
  readonly json: boolean;
  readonly markdown: boolean;
  readonly junit: boolean;
}

interface ReportCopyRequest {
  readonly root: string;
  readonly runId: string;
  readonly canonical: ProgressWriter;
  readonly outputDir: string;
  readonly reporterDir: string;
  readonly selection: ReportSelection;
  readonly strict: boolean;
}

export function reportSelection(options: RunCommandOptions): ReportSelection {
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
export async function openReportCopy(
  request: ReportCopyRequest,
): Promise<ProgressWriter | undefined> {
  const { root, runId, canonical, outputDir, reporterDir, selection, strict } =
    request;
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

  const writer = await ProgressWriter.create(root, runId, reporterDir, {
    json: selection.json,
    html: false,
    junit,
  });
  writer.command = canonical.command;
  return writer;
}

export interface RunFinish {
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
 * claim a result the others contradict.
 */
export async function finishRun(
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  result: RunResult,
  recordCopyFailure: (diagnostic: CliDiagnostic) => Promise<RunResult>,
): Promise<RunFinish> {
  const copied = await finishJsonCopy(copy, result, recordCopyFailure);
  try {
    await canonical.finish(copied.result);
    await finishJunitCopy(copy, copied);
    return {
      result: copied.result,
      diagnostic: copied.diagnostic,
      reportsAvailable: true,
      copyAvailable: copied.available,
    };
  } catch (error) {
    if (!isReportFailure(error, canonical, copy, copied.available)) throw error;
    return recoverReportFailure({
      canonical,
      copy,
      current: copied.result,
      error,
      copyAvailable: copied.available,
    });
  }
}

interface CopyResult {
  readonly result: RunResult;
  readonly diagnostic: CliDiagnostic | null;
  readonly available: boolean;
}

async function finishJsonCopy(
  copy: ProgressWriter | undefined,
  result: RunResult,
  recordFailure: (diagnostic: CliDiagnostic) => Promise<RunResult>,
): Promise<CopyResult> {
  if (!copy?.includesJson)
    return { result, diagnostic: null, available: copy !== undefined };
  try {
    await copy.finish(result, { reports: false });
    return { result, diagnostic: null, available: true };
  } catch {
    const diagnostic = outputDiagnostic(copy.resultPath);
    await copy.invalidate().catch(() => undefined);
    return {
      result: await recordFailure(diagnostic),
      diagnostic,
      available: false,
    };
  }
}

async function finishJunitCopy(
  copy: ProgressWriter | undefined,
  copied: CopyResult,
): Promise<void> {
  if (!copy) return;
  if (!copied.available) return;
  if (!copy.includesJunit) return;
  await copy.finish(copied.result, { json: false });
}

function isReportFailure(
  error: unknown,
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  copyAvailable: boolean,
): error is ProgressWriterError {
  if (!(error instanceof ProgressWriterError)) return false;
  if (canonical.isReport(error.path)) return true;
  if (!copy) return false;
  if (!copyAvailable) return false;
  return copy.isReport(error.path);
}

async function recoverReportFailure(request: {
  readonly canonical: ProgressWriter;
  readonly copy: ProgressWriter | undefined;
  readonly current: RunResult;
  readonly error: ProgressWriterError;
  readonly copyAvailable: boolean;
}): Promise<RunFinish> {
  const { canonical, copy, current, error } = request;
  let { copyAvailable } = request;
  const failure: CliDiagnostic = {
    code: "reporter_output_error",
    message: `The ${reportFormat(error.path)} report could not be written to ${error.path}.`,
    fix: "Check the run output directory and rerun the command.",
  };
  const failed = terminalOutputFailure(current, failure, true);
  await canonical.removeReports();
  copyAvailable = await recoverCopy(copy, copyAvailable, failed);
  await canonical.finish(failed, { reports: false });
  return {
    result: failed,
    diagnostic: failure,
    reportsAvailable: false,
    copyAvailable,
  };
}

async function recoverCopy(
  copy: ProgressWriter | undefined,
  available: boolean,
  result: RunResult,
): Promise<boolean> {
  if (!available) return false;
  if (!copy) return false;
  try {
    await copy.removeReports();
    if (copy.includesJson) await copy.finish(result, { reports: false });
    return true;
  } catch {
    await copy.invalidate().catch(() => undefined);
    return false;
  }
}

/** The files a finished run can point to, leaving out any that failed. */
export function finishedArtifacts(
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  selection: ReportSelection,
  finished: RunFinish,
): RunArtifactPaths {
  const junit = junitWriter(canonical, copy, finished.copyAvailable);
  const json = jsonWriter(canonical, copy, finished.copyAvailable);
  return {
    progressPath: canonical.progressPath,
    resultPath: canonical.resultPath,
    ...renderedArtifacts(canonical, junit, finished.reportsAvailable),
    ...reporterArtifact(selection, json),
    authoritative: true,
  };
}

function reporterArtifact(
  selection: ReportSelection,
  writer: ProgressWriter | undefined,
): Pick<RunArtifactPaths, "reporterPath"> | object {
  if (!selection.json) return {};
  return writer ? { reporterPath: writer.resultPath } : {};
}

function junitWriter(
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  copyAvailable: boolean,
): ProgressWriter | undefined {
  if (canonical.includesJunit) return canonical;
  if (!copyAvailable) return undefined;
  return copy?.includesJunit ? copy : undefined;
}

function jsonWriter(
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  copyAvailable: boolean,
): ProgressWriter | undefined {
  if (!copy?.includesJson) return canonical;
  return copyAvailable ? copy : undefined;
}

function renderedArtifacts(
  canonical: ProgressWriter,
  junit: ProgressWriter | undefined,
  available: boolean,
): Partial<RunArtifactPaths> {
  if (!available) return {};
  return {
    htmlPath: canonical.htmlPath,
    ...(canonical.includeMarkdown
      ? { markdownPath: canonical.markdownPath }
      : {}),
    ...(junit ? { junitPath: junit.junitPath } : {}),
  };
}

export function terminalOutputFailure(
  source: RunResult,
  diagnostic: CliDiagnostic,
  keepExisting = false,
): RunResult {
  if (keepExisting) {
    if (source.error === null) return failedRunResult(source, diagnostic);
    if (source.state !== "running") return source;
  }
  return failedRunResult(source, diagnostic);
}

function failedRunResult(
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

export async function resultWithoutSink(
  runId: string,
  diagnostic: CliDiagnostic,
): Promise<RunResult> {
  const recorder = new RunRecorder(async () => undefined, runId);
  await recorder.start();
  await recorder.finish(canonicalDiagnosticError(diagnostic));
  return recorder.snapshot;
}

/** A run that ends before executing anything still leaves requested files. */
export async function preExecutionFailure(request: {
  readonly root: string;
  readonly runId: string;
  readonly outputDir: string | undefined;
  readonly reporterDir: string;
  readonly selection: ReportSelection;
  readonly strict: boolean;
  readonly diagnostic: CliDiagnostic;
  readonly commit: () => void;
}): Promise<RunCommandExecution> {
  const { root, runId, outputDir, diagnostic, commit } = request;
  const base = outputDir ?? path.join(root, ".sedum", "runs");
  const intended = path.join(base, runId);
  const writer = await createPreExecutionWriter(request, base);
  if (!writer) {
    commit();
    return unavailablePreExecutionResult(runId, intended, diagnostic);
  }
  return finishPreExecutionFailure(request, writer, base);
}

async function createPreExecutionWriter(
  request: Parameters<typeof preExecutionFailure>[0],
  base: string,
): Promise<ProgressWriter | undefined> {
  try {
    return await ProgressWriter.create(request.root, request.runId, base, {
      markdown: request.selection.markdown,
    });
  } catch {
    return undefined;
  }
}

async function finishPreExecutionFailure(
  request: Parameters<typeof preExecutionFailure>[0],
  writer: ProgressWriter,
  base: string,
): Promise<RunCommandExecution> {
  const { root, runId, reporterDir, selection, strict, diagnostic, commit } =
    request;
  const copy = await openReportCopy({
    root,
    runId,
    canonical: writer,
    outputDir: base,
    reporterDir,
    selection,
    strict,
  }).catch(() => undefined);
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

async function unavailablePreExecutionResult(
  runId: string,
  intended: string,
  diagnostic: CliDiagnostic,
): Promise<RunCommandExecution> {
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
