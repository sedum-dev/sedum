import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { BrowserInstallResult, RunResult } from "@sedum-dev/core";
import { renderDiagnostic } from "./diagnostics.js";
import { runExitCode } from "./exit-policy.js";
import {
  clearProgress,
  renderProgress,
  renderRunSummary,
  type OutputCapabilities,
} from "./output.js";
import {
  executeRunCommand,
  type RunCommandExecution,
  type RunCommandOptions,
} from "./run-command.js";

export interface CliOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface CliRuntime {
  readonly capabilities?: OutputCapabilities;
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly signal?: AbortSignal;
  readonly onRunCommitted?: () => void;
  readonly executeRun?: (
    options: RunCommandOptions,
  ) => Promise<RunCommandExecution>;
  readonly installChromium?: (
    withDependencies: boolean,
  ) => BrowserInstallResult;
}

const plainOutput: OutputCapabilities = {
  stdoutIsTTY: false,
  stderrIsTTY: false,
  color: false,
};

function collectOrigin(value: string, previous: readonly string[]): string[] {
  try {
    return [...previous, new URL(value).origin];
  } catch {
    throw new InvalidArgumentError(
      `Invalid origin ${JSON.stringify(value)}. Use an absolute URL such as https://example.com.`,
    );
  }
}

function commandHelp(command: Command, writeErr: (value: string) => void) {
  command.outputHelp({ error: true });
  const commandPath: string[] = [];
  for (
    let current: Command | null = command;
    current;
    current = current.parent
  ) {
    commandPath.unshift(current.name());
  }
  writeErr(
    `Fix: run \`${commandPath.join(" ")} --help\` and provide a command.\n`,
  );
}

/** Parse and execute explicit argv without reading or exiting the process. */
export async function runCli(
  args: readonly string[],
  version: string,
  runtime: CliRuntime = {},
): Promise<CliOutput> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writeOut = runtime.stdout ?? ((value: string) => stdout.push(value));
  const writeErr = runtime.stderr ?? ((value: string) => stderr.push(value));
  const capabilities = runtime.capabilities ?? plainOutput;
  const executeRun = runtime.executeRun ?? executeRunCommand;
  let exitCode = 3;

  const program = new Command()
    .name("sedum")
    .description(
      "Run plain-English browser tests with deterministic automation.",
    )
    .version(version, "-v, --version", "print the installed Sedum version")
    .helpOption("-h, --help", "show command help")
    .showSuggestionAfterError()
    .showHelpAfterError("Run `sedum --help` to see available commands.")
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (value, write) => write(value),
    })
    .addHelpText(
      "after",
      "\nExamples:\n  sedum run tests/login.test.yaml\n  sedum browsers install chromium\n\nExit codes:\n  0 passed\n  1 failed test\n  2 flagged pass with --strict\n  3 command or operational error\n",
    );

  program.action(() => commandHelp(program, writeErr));

  program
    .command("run")
    .description("run one explicit *.test.yaml file")
    .argument("<file.test.yaml>", "test file to execute")
    .option("--replay", "capture replay frames for executed steps", false)
    .option("--no-evidence", "disable non-passing evidence frames")
    .option(
      "--sensitive-origin <url>",
      "omit sensitive page details and frames (repeatable)",
      collectOrigin,
      [],
    )
    .option("--strict", "exit 2 when a passed run has uncertainty flags", false)
    .option(
      "--costs",
      "show model tokens and cost even when stdout is redirected",
      false,
    )
    .addHelpText(
      "after",
      "\nPrerequisites:\n  Install Chromium with `sedum browsers install chromium` and set TYPESAFE_API_KEY.\n\nExamples:\n  sedum run tests/login.test.yaml\n  sedum run tests/login.test.yaml --strict --costs\n",
    )
    .action(
      async (
        file: string,
        options: {
          replay: boolean;
          evidence: boolean;
          sensitiveOrigin: string[];
          strict: boolean;
          costs: boolean;
        },
      ) => {
        let transient = false;
        const execution = await executeRun({
          file,
          replay: options.replay,
          evidence: options.evidence,
          sensitiveOrigins: options.sensitiveOrigin,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          ...(runtime.onRunCommitted
            ? { onCommitted: runtime.onRunCommitted }
            : {}),
          onSnapshot: (snapshot: RunResult) => {
            const progress = renderProgress(snapshot, capabilities);
            if (progress) {
              transient = true;
              writeOut(progress);
            }
          },
        });
        if (transient) writeOut(clearProgress(capabilities));
        writeOut(
          renderRunSummary(
            execution.result,
            capabilities,
            execution.artifacts,
            options.costs,
          ),
        );
        if (execution.diagnostic)
          writeErr(renderDiagnostic(execution.diagnostic));
        exitCode = runExitCode(execution.result, options.strict);
      },
    );

  const browsers = program
    .command("browsers")
    .description("manage browser binaries required by Sedum");
  browsers.action(() => commandHelp(browsers, writeErr));
  browsers
    .command("install")
    .description("install a browser binary")
    .argument("<browser>", "browser to install (currently: chromium)")
    .option(
      "--with-deps",
      "also install supported Linux system dependencies",
      false,
    )
    .addHelpText(
      "after",
      "\nExample:\n  sedum browsers install chromium --with-deps\n",
    )
    .action(async (browser: string, options: { withDeps: boolean }) => {
      if (browser !== "chromium") {
        writeErr(
          `Unsupported browser ${JSON.stringify(browser)}.\nFix: use \`sedum browsers install chromium\`.\n`,
        );
        exitCode = 3;
        return;
      }
      const install =
        runtime.installChromium ??
        (await import("@sedum-dev/core")).installChromium;
      const result = install(options.withDeps);
      if (result.stdout) writeOut(result.stdout);
      if (result.stderr) writeErr(result.stderr);
      if (result.exitCode === 0) exitCode = 0;
      else {
        writeErr(
          "Fix: resolve the installer error above, then rerun `sedum browsers install chromium`.\n",
        );
        exitCode = 3;
      }
    });

  try {
    await program.parseAsync(["node", "sedum", ...args]);
  } catch (error) {
    if (error instanceof CommanderError) {
      exitCode = error.exitCode === 0 ? 0 : 3;
      if (error.exitCode !== 0)
        writeErr(
          "Fix: correct the command shown above and rerun it, or use `sedum --help`.\n",
        );
    } else {
      writeErr(
        "The command could not be parsed safely.\nFix: run `sedum --help` and correct the command.\n",
      );
      exitCode = 3;
    }
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}
