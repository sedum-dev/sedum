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
import { openLocatorCache } from "./locator-cache-store.js";
import type { RunArtifactPaths } from "./output.js";

export interface RunCommandOptions {
  readonly file: string;
  readonly replay: boolean;
  readonly evidence: boolean;
  readonly sensitiveOrigins: readonly string[];
  readonly locatorCacheDisabled?: boolean;
  readonly locatorCacheCi?: boolean;
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

export async function executeRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  const root = process.cwd();
  const runId = randomUUID();
  let committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    options.onCommitted?.();
  };
  let writer: ProgressWriter;
  try {
    writer = await ProgressWriter.create(root, runId);
  } catch {
    commit();
    const intended = path.join(root, ".sedum", "runs", runId);
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
    const provider = new TypeSafeAdapter();
    const cache = await FileClassificationCache.load(
      path.join(root, ".sedum", "classifications.json"),
      "jev-latest",
    );
    const locatorCache = await openLocatorCache(root, {
      disabled: options.locatorCacheDisabled ?? false,
      ciOptIn: options.locatorCacheCi ?? false,
      env: process.env,
    });
    const result = await runFlow(options.file, {
      repoRoot: root,
      browser: new PlaywrightBrowserDriver(),
      provider,
      classificationCache: cache,
      locatorCache,
      env: process.env,
      headless: process.env.SEDUM_HEADED === "1" ? false : true,
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
    if (result.status === "could_not_run") {
      const diagnostic = flowDiagnostic(result);
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
