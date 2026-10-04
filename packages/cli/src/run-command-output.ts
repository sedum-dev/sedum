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
    if (!isReportFailure(error, canonical, copy, copyAvailable)) throw error;
    return recoverReportFailure({
      canonical,
      copy,
      current,
      error,
      copyAvailable,
    });
  }
}

function isReportFailure(
  error: unknown,
  canonical: ProgressWriter,
  copy: ProgressWriter | undefined,
  copyAvailable: boolean,
): error is ProgressWriterError {
  return (
    error instanceof ProgressWriterError &&
    (canonical.isReport(error.path) ||
      Boolean(copy && copyAvailable && copy.isReport(error.path)))
  );
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
  if (copy && copyAvailable) {
    try {
      await copy.removeReports();
      if (copy.includesJson) await copy.finish(failed, { reports: false });
    } catch {
      copyAvailable = false;
      await copy.invalidate().catch(() => undefined);
    }
  }
  await canonical.finish(failed, { reports: false });
  return {
    result: failed,
    diagnostic: failure,
    reportsAvailable: false,
    copyAvailable,
  };
}

/** The files a finished run can point to, leaving out any that failed. */
export function finishedArtifacts(
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

export function terminalOutputFailure(
  source: RunResult,
  diagnostic: CliDiagnostic,
  keepExisting = false,
): RunResult {
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
  const {
    root,
    runId,
    outputDir,
    reporterDir,
    selection,
    strict,
    diagnostic,
    commit,
  } = request;
  const base = outputDir ?? path.join(root, ".sedum", "runs");
  const intended = path.join(base, runId);
  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(root, runId, base, {
      markdown: selection.markdown,
    });
  } catch {
    commit();
    return unavailablePreExecutionResult(runId, intended, diagnostic);
  }
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
