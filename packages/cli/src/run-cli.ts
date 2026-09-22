import {
  FileClassificationCache,
  PlaywrightBrowserDriver,
  RunRecorder,
  runFlow,
} from "@sedum-dev/core";
import { TypeSafeAdapter } from "@sedum-dev/provider-typesafe";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProgressWriter } from "./progress-writer.js";

export interface CliOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Pure argument handling; the executable owns process I/O. */
export async function runCli(
  args: readonly string[],
  version: string,
  onProgressPath?: (path: string) => void,
  signal?: AbortSignal,
): Promise<CliOutput> {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      stdout:
        "Usage: sedum run <file.test.yaml> [--replay] [--no-evidence] [--sensitive-origin=URL] | sedum --version | sedum --help | sedum browsers install chromium [--with-deps]\nRun needs Chromium and TYPESAFE_API_KEY.\n",
      stderr: "",
      exitCode: 0,
    };
  }
  if (
    (args.length === 3 || args.length === 4) &&
    args[0] === "browsers" &&
    args[1] === "install" &&
    args[2] === "chromium" &&
    (args.length === 3 || args[3] === "--with-deps")
  ) {
    const { installChromium } = await import("@sedum-dev/core");
    const result = installChromium(args[3] === "--with-deps");
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
  if (
    args.length >= 2 &&
    args[0] === "run" &&
    args
      .slice(2)
      .every(
        (arg) =>
          arg === "--replay" ||
          arg === "--no-evidence" ||
          arg.startsWith("--sensitive-origin="),
      )
  ) {
    const root = process.cwd();
    let writer: ProgressWriter | undefined;
    let recorder: RunRecorder | undefined;
    const options = args.slice(2);
    try {
      const runId = randomUUID();
      writer = await ProgressWriter.create(root, runId);
      recorder = new RunRecorder((snapshot) => writer!.write(snapshot), runId);
      await recorder.start();
      onProgressPath?.(writer.progressPath);
      if (signal?.aborted) throw new Error("Run interrupted");
      const sensitiveOrigins = options
        .filter((arg) => arg.startsWith("--sensitive-origin="))
        .map((arg) => new URL(arg.slice("--sensitive-origin=".length)).origin);
      const privacy = { secretValues: [] as string[], sensitiveOrigins };
      const provider = new TypeSafeAdapter();
      const cache = await FileClassificationCache.load(
        path.join(root, ".sedum", "classifications.json"),
        "jev-latest",
      );
      const result = await runFlow(args[1]!, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        provider,
        classificationCache: cache,
        env: process.env,
        headless: process.env.SEDUM_HEADED === "1" ? false : true,
        ...(signal ? { signal } : {}),
        report: {
          recorder,
          privacy,
          evidenceEnabled: !options.includes("--no-evidence"),
          replay: options.includes("--replay"),
          saveFrame: (stepId, bytes) => writer!.saveFrame(stepId, bytes),
        },
      });
      if (signal?.aborted) {
        await recorder.finish(
          { code: "canceled", message: "The run was interrupted." },
          "interrupted",
        );
        await writer.finish(recorder.snapshot);
        return {
          stdout: onProgressPath ? "" : `progress ${writer.progressPath}\n`,
          stderr: "The run was interrupted.\n",
          exitCode: 3,
        };
      }
      if (result.status === "could_not_run") {
        await recorder.finish({
          code: "execution_error",
          message: "The run could not complete.",
        });
        await writer.finish(recorder.snapshot);
        return {
          stdout: onProgressPath ? "" : `progress ${writer.progressPath}\n`,
          stderr: `${result.source ? `${result.source.file}:${result.source.line}:${result.source.col}: ` : ""}${result.message}\n`,
          exitCode: 3,
        };
      }
      await recorder.finish();
      await writer.finish(recorder.snapshot);
      const prefix = onProgressPath ? "" : `progress ${writer.progressPath}\n`;
      if (result.status === "passed")
        return {
          stdout: `${prefix}passed ${result.file}\n`,
          stderr: "",
          exitCode: 0,
        };
      if (result.status === "failed")
        return {
          stdout: `${prefix}failed ${result.file}:${result.source.line}:${result.source.col}\n`,
          stderr: "",
          exitCode: 1,
        };
    } catch (error) {
      if (recorder && writer && recorder.snapshot.state === "running") {
        try {
          await recorder.finish(
            {
              code: signal?.aborted ? "canceled" : "setup_or_output_error",
              message: signal?.aborted
                ? "The run was interrupted."
                : "The run could not complete.",
            },
            signal?.aborted ? "interrupted" : "error",
          );
          await writer.finish(recorder.snapshot);
        } catch {
          /* The output path itself may be unwritable. */
        }
      }
      return {
        stdout:
          writer && !onProgressPath ? `progress ${writer.progressPath}\n` : "",
        stderr: `${signal?.aborted ? "The run was interrupted." : writer ? "The run could not complete." : error instanceof Error ? error.message : "Could not create run output."}\n`,
        exitCode: 3,
      };
    }
  }
  return {
    stdout: "",
    stderr: "Unknown or unavailable command. Use sedum --help.\n",
    exitCode: 2,
  };
}
