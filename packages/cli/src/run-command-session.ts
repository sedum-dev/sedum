import { RunRecorder, type RunResult } from "@sedum-dev/core";
import path from "node:path";
import type { ResolvedProjectConfig } from "./config.js";
import {
  canonicalDiagnosticError,
  outputDiagnostic,
  type CliDiagnostic,
} from "./diagnostics.js";
import type { RunArtifactPaths } from "./output.js";
import { ProgressWriter, ProgressWriterError } from "./progress-writer.js";
import type { RunCommandExecution, RunCommandOptions } from "./run-command.js";
import {
  ReporterOutputError,
  finishRun,
  finishedArtifacts,
  openReportCopy,
  resultWithoutSink,
  terminalOutputFailure,
  type ReportSelection,
} from "./run-command-output.js";

interface SessionRequest {
  readonly config: ResolvedProjectConfig;
  readonly runId: string;
  readonly options: RunCommandOptions;
  readonly reports: ReportSelection;
  readonly commit: () => void;
}

export type OpenRunSession =
  | { readonly session: RunOutputSession; readonly execution?: never }
  | { readonly session?: never; readonly execution: RunCommandExecution };

export async function openRunSession(
  request: SessionRequest,
): Promise<OpenRunSession> {
  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(
      request.config.projectRoot,
      request.runId,
      request.config.outputDir,
      { markdown: request.reports.markdown },
    );
    writer.command = request.options.command ?? "sedum";
  } catch {
    request.commit();
    const intended = path.join(request.config.outputDir, request.runId);
    const diagnostic = outputDiagnostic(path.join(intended, "result.json"));
    return {
      execution: {
        result: await resultWithoutSink(request.runId, diagnostic),
        artifacts: {
          progressPath: path.join(intended, "progress.json"),
          resultPath: path.join(intended, "result.json"),
          authoritative: false,
        },
        diagnostic,
      },
    };
  }
  return { session: new RunOutputSession(writer, request) };
}

export class RunOutputSession {
  readonly recorder: RunRecorder;
  readonly writer: ProgressWriter;
  private reportWriter: ProgressWriter | undefined;
  private currentArtifacts: RunArtifactPaths;
  private failedReporter = false;

  constructor(
    writer: ProgressWriter,
    private readonly request: SessionRequest,
  ) {
    this.writer = writer;
    this.currentArtifacts = {
      progressPath: writer.progressPath,
      resultPath: writer.resultPath,
      htmlPath: writer.htmlPath,
      ...(request.reports.markdown
        ? { markdownPath: writer.markdownPath }
        : {}),
      authoritative: true,
    };
    this.recorder = new RunRecorder(
      (snapshot) => this.writeSnapshot(snapshot),
      request.runId,
    );
  }

  get reporterFailed(): boolean {
    return this.failedReporter;
  }

  get artifacts(): RunArtifactPaths {
    return this.currentArtifacts;
  }

  async start(): Promise<RunCommandExecution | null> {
    try {
      await this.recorder.start();
      return null;
    } catch (error) {
      if (error instanceof ReporterOutputError) return this.reporterFailure();
      this.request.commit();
      const diagnostic = outputDiagnostic(this.writer.progressPath);
      await this.writer.invalidate();
      return {
        result: await resultWithoutSink(this.request.runId, diagnostic),
        artifacts: { ...this.currentArtifacts, authoritative: false },
        diagnostic,
      };
    }
  }

  async openReportCopy(): Promise<RunCommandExecution | null> {
    const { config, runId, options, reports, commit } = this.request;
    try {
      this.reportWriter = await openReportCopy({
        root: config.projectRoot,
        runId,
        canonical: this.writer,
        outputDir: config.outputDir,
        reporterDir: config.reporterDir,
        selection: reports,
        strict: options.strict ?? false,
      });
    } catch {
      const diagnostic = outputDiagnostic(
        path.join(config.reporterDir, runId, "result.json"),
      );
      commit();
      await this.recorder.finish(canonicalDiagnosticError(diagnostic));
      const finished = await finishRun(
        this.writer,
        undefined,
        this.recorder.snapshot,
        async () => this.recorder.snapshot,
      );
      return {
        result: finished.result,
        artifacts: finishedArtifacts(this.writer, undefined, reports, {
          ...finished,
          copyAvailable: false,
        }),
        diagnostic: finished.diagnostic ?? diagnostic,
      };
    }
    const junitWriter = this.writer.includesJunit
      ? this.writer
      : this.reportWriter?.includesJunit
        ? this.reportWriter
        : undefined;
    if (junitWriter)
      this.currentArtifacts = {
        ...this.currentArtifacts,
        junitPath: junitWriter.junitPath,
      };
    return null;
  }

  async terminalExecution(
    diagnostic: CliDiagnostic | null,
  ): Promise<RunCommandExecution> {
    try {
      const finished = await finishRun(
        this.writer,
        this.reportWriter,
        this.recorder.snapshot,
        (failure) => this.recordCopyFailure(failure),
      );
      return {
        result: finished.result,
        artifacts: finishedArtifacts(
          this.writer,
          this.reportWriter,
          this.request.reports,
          finished,
        ),
        diagnostic: finished.diagnostic ?? diagnostic,
        reporterFailed: this.failedReporter,
        onReporterFailure: () => this.reporterFailure(),
      };
    } catch (error) {
      const output = outputDiagnostic(
        error instanceof ProgressWriterError
          ? error.path
          : this.writer.resultPath,
      );
      const result = terminalOutputFailure(this.recorder.snapshot, output);
      await this.writer.invalidate();
      await this.reportWriter?.invalidate();
      return {
        result,
        artifacts: { ...this.currentArtifacts, authoritative: false },
        diagnostic: output,
      };
    }
  }

  async reporterFailure(): Promise<RunCommandExecution> {
    const diagnostic: CliDiagnostic = {
      code: "reporter_output_error",
      message: "The selected reporter could not write output.",
      fix: "Check terminal output access and rerun the command.",
    };
    const result = terminalOutputFailure(this.recorder.snapshot, diagnostic);
    try {
      const finished = await finishRun(
        this.writer,
        this.reportWriter,
        result,
        async () => result,
      );
      return {
        result: finished.result,
        artifacts: finishedArtifacts(
          this.writer,
          this.reportWriter,
          this.request.reports,
          finished,
        ),
        diagnostic: finished.diagnostic ?? diagnostic,
        reporterFailed: true,
      };
    } catch (error) {
      await this.writer.invalidate();
      await this.reportWriter?.invalidate();
      const output = outputDiagnostic(
        error instanceof ProgressWriterError
          ? error.path
          : this.writer.resultPath,
      );
      return {
        result: terminalOutputFailure(result, output),
        artifacts: { ...this.currentArtifacts, authoritative: false },
        diagnostic: output,
        reporterFailed: true,
      };
    }
  }

  private async writeSnapshot(snapshot: RunResult): Promise<void> {
    await this.writer.write(snapshot);
    if (this.failedReporter) return;
    try {
      this.request.options.onSnapshot?.(snapshot, this.currentArtifacts);
    } catch {
      this.failedReporter = true;
      throw new ReporterOutputError(
        "The selected reporter could not write output.",
      );
    }
  }

  private async recordCopyFailure(
    diagnostic: CliDiagnostic,
  ): Promise<RunResult> {
    if (this.recorder.snapshot.error === null)
      await this.recorder.finish(canonicalDiagnosticError(diagnostic));
    return this.recorder.snapshot;
  }
}
