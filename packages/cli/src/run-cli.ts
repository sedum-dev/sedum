import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { BrowserInstallResult, RunResult } from "@sedum-dev/core";
import { renderDiagnostic } from "./diagnostics.js";
import { clearLocatorCache } from "./locator-cache-store.js";
import { listExitCode, runExitCode, validateExitCode } from "./exit-policy.js";
import { executeListCommand } from "./list-command.js";
import { renderConfigErrors } from "./project-context.js";
import {
  clearProgress,
  renderProgress,
  renderRunSummary,
  type OutputCapabilities,
} from "./output.js";
import type { RunCommandExecution, RunCommandOptions } from "./run-command.js";
import {
  createTypeSafeClassifier,
  executeValidateCommand,
  type ClassificationProviderFactory,
} from "./validate-command.js";
import {
  renderListInvalid,
  renderListJson,
  renderListTable,
  renderProblems,
  renderValidation,
} from "./validate-output.js";

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
  /** Project root for `validate` and `list`; defaults to the process cwd. */
  readonly cwd?: string;
  /** Used only by `validate --online`. */
  readonly createClassificationProvider?: ClassificationProviderFactory;
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
  // Loaded lazily so `validate` and `list` never load the provider or browser code.
  const executeRun =
    runtime.executeRun ??
    (async (options: RunCommandOptions) =>
      (await import("./run-command.js")).executeRunCommand(options));
  const cwd = runtime.cwd ?? process.cwd();
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
      "\nExamples:\n  sedum run tests/login.test.yaml\n  sedum validate\n  sedum list --json\n  sedum browsers install chromium\n\nExit codes:\n  0 passed\n  1 failed test (validate and list: invalid test files)\n  2 flagged pass with --strict\n  3 command or operational error\n",
    );

  program.action(() => commandHelp(program, writeErr));

  program
    .command("run")
    .description("run configured tests or one explicit *.test.yaml file")
    .argument("[file.test.yaml]", "test file to execute")
    .option("--replay", "capture replay frames for executed steps", false)
    .option("--no-evidence", "disable non-passing evidence frames")
    .option("--no-locator-cache", "disable the local locator cache")
    .option("--locator-cache-ci", "enable the local locator cache in CI", false)
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
        file: string | undefined,
        options: {
          replay: boolean;
          evidence: boolean;
          sensitiveOrigin: string[];
          strict: boolean;
          costs: boolean;
          locatorCache: boolean;
          locatorCacheCi: boolean;
        },
      ) => {
        let transient = false;
        const execution = await executeRun({
          ...(file ? { file } : {}),
          replay: options.replay,
          evidence: options.evidence,
          sensitiveOrigins: options.sensitiveOrigin,
          locatorCacheDisabled: !options.locatorCache,
          locatorCacheCi: options.locatorCacheCi,
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

  const cache = program
    .command("cache")
    .description("manage the local locator cache");
  cache.action(() => commandHelp(cache, writeErr));
  cache
    .command("clear")
    .description("remove the current worktree's locator cache and digest key")
    .action(async () => {
      const cleared = await clearLocatorCache(process.cwd());
      writeOut(
        cleared
          ? "Local locator cache cleared.\n"
          : "No Git checkout locator cache was found.\n",
      );
      exitCode = 0;
    });

  program
    .command("validate")
    .description(
      "check tests and modules without a browser or model key (offline by default)",
    )
    .argument(
      "[paths...]",
      "test files, module files, or directories relative to the project root (default: configured tests)",
    )
    .option(
      "--online",
      "classify sentences the offline cache cannot, using TYPESAFE_API_KEY, and update .sedum/classifications.json",
      false,
    )
    .addHelpText(
      "after",
      "\nOffline validation reads only your files and the committed .sedum/classifications.json.\nA sentence it cannot classify is reported as `not checked offline`, never as valid.\n\nExamples:\n  sedum validate\n  sedum validate tests/login.test.yaml\n  sedum validate --online\n\nExit codes:\n  0 every test and module is valid\n  1 invalid content or sentences not checked offline\n  3 invalid config, bad paths, no files found, or the check could not run\n",
    )
    .action(async (paths: string[], options: { online: boolean }) => {
      const execution = await executeValidateCommand({
        paths,
        online: options.online,
        cwd,
        createProvider:
          runtime.createClassificationProvider ?? createTypeSafeClassifier,
        ...(runtime.signal ? { signal: runtime.signal } : {}),
      });
      const problems = execution.discovery?.problems ?? [];
      writeErr(renderConfigErrors(execution.configErrors, cwd));
      writeErr(renderProblems(problems));
      if (execution.setup) writeErr(renderDiagnostic(execution.setup));
      if (execution.result && execution.discovery)
        writeOut(
          renderValidation(
            execution.result,
            execution.discovery.root,
            capabilities,
          ),
        );
      exitCode = validateExitCode(
        execution.result,
        execution.configErrors.length > 0 ||
          problems.length > 0 ||
          execution.setup !== null,
      );
    });

  program
    .command("list")
    .description("list discovered tests with their ids, tags, and paths")
    .argument(
      "[paths...]",
      "test files or directories relative to the project root (default: configured tests)",
    )
    .option("--json", "print a versioned JSON listing on stdout", false)
    .addHelpText(
      "after",
      "\nExamples:\n  sedum list\n  sedum list tests --json\n\nExit codes:\n  0 listed (including when no tests are found)\n  1 some files could not be listed; run `sedum validate` for details\n  3 invalid config or bad paths\n",
    )
    .action(async (paths: string[], options: { json: boolean }) => {
      const execution = await executeListCommand({ paths, cwd });
      const problems = execution.discovery?.problems ?? [];
      writeErr(renderConfigErrors(execution.configErrors, cwd));
      writeErr(renderProblems(problems));
      if (execution.listing) {
        if (options.json) writeOut(renderListJson(execution.listing));
        else {
          writeOut(renderListTable(execution.listing));
          writeErr(renderListInvalid(execution.listing));
        }
      }
      exitCode = listExitCode(
        execution.listing,
        execution.configErrors.length > 0 || problems.length > 0,
      );
    });

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
