import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { BrowserInstallResult, RunResult } from "@sedum-dev/core";
import {
  createTerminalReporter,
  ReporterLifecycle,
  type ReporterContext,
  type TerminalReporterName,
} from "@sedum-dev/reporters";
import { renderDiagnostic } from "./diagnostics.js";
import { clearLocatorCache } from "./locator-cache-store.js";
import { listExitCode, runExitCode, validateExitCode } from "./exit-policy.js";
import { executeListCommand } from "./list-command.js";
import { renderConfigErrors } from "./project-context.js";
import {
  renderRunSummary,
  type RunArtifactPaths,
  type OutputCapabilities,
} from "./output.js";
import type { RunCommandExecution, RunCommandOptions } from "./run-command.js";
import type { DoctorProbes } from "./doctor-command.js";
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
  readonly onRunDeadline?: () => void;
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
  readonly doctorProbes?: DoctorProbes;
  readonly confirmInit?: (question: string) => Promise<boolean>;
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

function collectValue(value: string, previous: readonly string[]): string[] {
  if (!value.trim()) throw new InvalidArgumentError("Value must not be blank.");
  return [...previous, value];
}

function collectReporter(value: string, previous: readonly string[]): string[] {
  if (!["list", "steps", "terminal", "json"].includes(value))
    throw new InvalidArgumentError(
      `Unknown reporter ${JSON.stringify(value)}. Use list or steps for terminal output, or terminal or json.`,
    );
  return previous.includes(value) ? [...previous] : [...previous, value];
}

function collectGlob(value: string, previous: readonly string[]): string[] {
  if (
    !value.trim() ||
    value.startsWith("/") ||
    /^[A-Za-z]:[/\\]/u.test(value) ||
    value.split(/[/\\]/u).includes("..")
  )
    throw new InvalidArgumentError(
      "Glob must be a nonempty project-relative path without '..'.",
    );
  return [...previous, value];
}

function collectLabels(value: string, previous: readonly string[]): string[] {
  const labels = value.split(",").map((item) => item.trim());
  if (labels.some((item) => !item))
    throw new InvalidArgumentError(
      "Labels must be nonempty comma-separated tags.",
    );
  return [...previous, ...labels];
}

function nonnegativeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 20)
    throw new InvalidArgumentError("Expected an integer from 0 to 20.");
  return number;
}

function nonnegativeSlow(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 30000)
    throw new InvalidArgumentError("Expected milliseconds from 0 to 30000.");
  return number;
}

function positiveMinutes(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1440)
    throw new InvalidArgumentError(
      "Expected minutes greater than 0 and at most 1440.",
    );
  return number;
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
      "\nExamples:\n  sedum init\n  sedum run tests/login.test.yaml\n  sedum validate\n  sedum list --json\n  sedum doctor --json\n  sedum browsers install chromium\n\nExit codes:\n  0 passed\n  1 failed test (validate and list: invalid test files)\n  2 flagged pass with --strict\n  3 command or operational error\n",
    );

  program.action(() => commandHelp(program, writeErr));

  program
    .command("init")
    .description("scaffold a runnable Sedum project in the current directory")
    .addHelpText(
      "after",
      "\nCreates a config, a SauceDemo example, .env.example, and ignore rules.\nExisting files are never replaced.\n",
    )
    .action(async () => {
      const { executeInitCommand } = await import("./init-command.js");
      const interactive =
        capabilities.stdoutIsTTY &&
        (process.stdin.isTTY === true || runtime.confirmInit !== undefined);
      const confirm =
        runtime.confirmInit ??
        (interactive
          ? async (question: string) => {
              const { createInterface } =
                await import("node:readline/promises");
              const prompt = createInterface({
                input: process.stdin,
                output: process.stdout,
              });
              try {
                const answer = await prompt.question(`${question} [y/N] `);
                return /^(?:y|yes)$/iu.test(answer.trim());
              } finally {
                prompt.close();
              }
            }
          : undefined);
      const result = await executeInitCommand({
        cwd,
        interactive,
        color: capabilities.color,
        ...(confirm ? { confirm } : {}),
        onOutput: writeOut,
      });
      writeErr(result.stderr);
      exitCode = result.exitCode;
    });

  program
    .command("run")
    .description("run configured tests, files, or directories")
    .argument(
      "[paths...]",
      "test files or directories relative to the project root",
    )
    .option(
      "--include <glob>",
      "include matching project-relative paths (repeatable)",
      collectGlob,
      [],
    )
    .option(
      "--exclude <glob>",
      "exclude matching project-relative paths (repeatable)",
      collectGlob,
      [],
    )
    .option(
      "--labels <tags>",
      "require all comma-separated test tags (repeatable)",
      collectLabels,
      [],
    )
    .option(
      "--name <text>",
      "match id or description substring (repeatable)",
      collectValue,
      [],
    )
    .option("--env <name>", "select a named environment")
    .option("--browser <kind>", "chrome or chromium")
    .option(
      "--url-override <url>",
      "replace entry URL origin for preview deployments",
    )
    .option("--output-dir <path>", "run output directory")
    .option("--reporter-dir <path>", "reporter artifact directory")
    .option("--headed", "show the browser", false)
    .option(
      "--slow <ms>",
      "slow browser actions by milliseconds",
      nonnegativeSlow,
    )
    .option(
      "--retries <count>",
      "additional whole-test attempts",
      nonnegativeInteger,
      0,
    )
    .option(
      "--timeout-minutes <minutes>",
      "whole-run deadline",
      positiveMinutes,
    )
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
      "--reporter <name>",
      "reporter: list, steps, terminal, or json (repeatable; default list)",
      collectReporter,
      [],
    )
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
        paths: string[],
        options: {
          include: string[];
          exclude: string[];
          labels: string[];
          name: string[];
          env?: string;
          browser?: string;
          urlOverride?: string;
          outputDir?: string;
          reporterDir?: string;
          reporter: string[];
          headed: boolean;
          slow?: number;
          retries: number;
          timeoutMinutes?: number;
          replay: boolean;
          evidence: boolean;
          sensitiveOrigin: string[];
          strict: boolean;
          costs: boolean;
          locatorCache: boolean;
          locatorCacheCi: boolean;
        },
      ) => {
        const lifecycle = new ReporterLifecycle();
        const terminalNames = options.reporter.length
          ? options.reporter
              .filter((name) => name !== "json")
              .map((name) => (name === "terminal" ? "list" : name))
          : ["list"];
        const reporters = [...new Set(terminalNames)].map((name) =>
          createTerminalReporter(name as TerminalReporterName),
        );
        const context = (artifacts: RunArtifactPaths): ReporterContext => ({
          stdoutIsTTY: capabilities.stdoutIsTTY,
          color: capabilities.color,
          showCosts: options.costs,
          ...(paths.length === 1 ? { rerunFile: paths[0] } : {}),
          ...artifacts,
          includeSharedSummary: true,
        });
        const emit = (snapshot: RunResult, artifacts: RunArtifactPaths) => {
          const events = lifecycle.feed(snapshot);
          for (const event of events)
            for (const [index, reporter] of reporters.entries()) {
              if (event.type === "runStarted" && index > 0) continue;
              const output = reporter.onEvent(event, context(artifacts));
              if (output) writeOut(output);
            }
        };
        const execution = await executeRun({
          paths,
          filters: {
            include: options.include,
            exclude: options.exclude,
            labels: options.labels,
            names: options.name,
          },
          ...(options.env ? { environment: options.env } : {}),
          ...(options.browser ? { browser: options.browser } : {}),
          ...(options.urlOverride ? { urlOverride: options.urlOverride } : {}),
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
          ...(options.reporterDir ? { reporterDir: options.reporterDir } : {}),
          reporters: options.reporter,
          headed: options.headed,
          ...(options.slow !== undefined ? { slowMoMs: options.slow } : {}),
          retries: options.retries,
          ...(options.timeoutMinutes !== undefined
            ? { timeoutMinutes: options.timeoutMinutes }
            : {}),
          replay: options.replay,
          evidence: options.evidence,
          sensitiveOrigins: options.sensitiveOrigin,
          locatorCacheDisabled: !options.locatorCache,
          locatorCacheCi: options.locatorCacheCi,
          ...(runtime.signal ? { signal: runtime.signal } : {}),
          ...(runtime.onRunCommitted
            ? { onCommitted: runtime.onRunCommitted }
            : {}),
          ...(runtime.onRunDeadline
            ? { onDeadline: runtime.onRunDeadline }
            : {}),
          onSnapshot: emit,
        });
        if (!execution.reporterFailed && reporters.length) {
          try {
            emit(execution.result, execution.artifacts);
            writeOut(
              renderRunSummary(
                execution.result,
                capabilities,
                execution.artifacts,
                options.costs,
              ),
            );
            for (const [index, reporter] of reporters.entries()) {
              const output = reporter.onResult(execution.result, {
                ...context(execution.artifacts),
                includeSharedSummary: index === 0,
              });
              if (output) writeOut(output);
            }
          } catch {
            const failure = await execution.onReporterFailure?.();
            writeErr(
              renderDiagnostic(
                failure?.diagnostic ?? {
                  code: "reporter_output_error",
                  message: "The selected reporter could not write output.",
                  fix: "Check terminal output access and rerun the command.",
                },
              ),
            );
            exitCode = 3;
            return;
          }
        }
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
    .command("doctor")
    .description("check whether this environment can run Sedum")
    .option("--json", "print versioned JSON checks on stdout", false)
    .addHelpText(
      "after",
      "\nThe authenticated API check makes one small, potentially billable request.\n\nExit codes:\n  0 all checks passed\n  3 one or more prerequisites failed\n",
    )
    .action(async (options: { json: boolean }) => {
      const { executeDoctorCommand, renderDoctorText } =
        await import("./doctor-command.js");
      const result = await executeDoctorCommand(cwd, runtime.doctorProbes);
      writeOut(
        options.json ? `${JSON.stringify(result)}\n` : renderDoctorText(result),
      );
      exitCode = result.checks.every((check) => check.status === "pass")
        ? 0
        : 3;
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
