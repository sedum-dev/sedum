import { withCommand } from "./invocation.js";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { BrowserInstallResult, RunResult } from "@sedum-dev/core";
import {
  createTerminalReporter,
  ReporterLifecycle,
  type ReporterContext,
  type TerminalReporterName,
} from "@sedum-dev/reporters";
import { renderDiagnostic } from "./diagnostics.js";
import {
  MAX_PARALLEL,
  parseParallel,
  type ParallelRequest,
} from "./run-pool.js";
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
import type { RelevanceProviderFactory } from "./affected-selection.js";
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
  /** A stray rejection from test code after the run was reported. */
  readonly onStrayRejection?: (message: string) => void;
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
  readonly createRelevanceProvider?: RelevanceProviderFactory;
  readonly doctorProbes?: DoctorProbes;
  /** How the user invokes sedum, for hints; the entry point detects it. */
  readonly command?: "sedum" | "npx sedum";
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

const REPORTERS = ["list", "steps", "terminal", "json", "markdown", "junit"];

/** `--reporter` is repeatable and also takes a comma list, e.g. junit,markdown. */
function collectReporter(value: string, previous: readonly string[]): string[] {
  const selected = [...previous];
  for (const item of value.split(",").map((name) => name.trim())) {
    if (!REPORTERS.includes(item))
      throw new InvalidArgumentError(
        `Unknown reporter ${JSON.stringify(item)}. Use list or steps for terminal output, or terminal, json, markdown, or junit.`,
      );
    if (!selected.includes(item)) selected.push(item);
  }
  return selected;
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

function parallelValue(value: string): ParallelRequest {
  const parsed = parseParallel(value);
  if (parsed === null)
    throw new InvalidArgumentError(
      `Expected auto or an integer from 1 to ${MAX_PARALLEL}.`,
    );
  return parsed;
}

function positiveCount(maximum: number) {
  return (value: string): number => {
    const number = Number(value);
    if (
      !/^[1-9]\d*$/u.test(value) ||
      !Number.isSafeInteger(number) ||
      number > maximum
    )
      throw new InvalidArgumentError(
        `Expected an integer from 1 to ${maximum}.`,
      );
    return number;
  };
}

function positiveMinutes(value: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1440)
    throw new InvalidArgumentError(
      "Expected minutes greater than 0 and at most 1440.",
    );
  return number;
}

function relevanceThreshold(value: string): number {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || number < 0 || number > 1)
    throw new InvalidArgumentError("Expected a probability from 0 to 1.");
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
  // Hints name the command the user can actually type again.
  const command = runtime.command ?? "sedum";
  const rawOut = runtime.stdout ?? ((value: string) => stdout.push(value));
  const rawErr = runtime.stderr ?? ((value: string) => stderr.push(value));
  const writeOut = (value: string) => rawOut(withCommand(value, command));
  const writeErr = (value: string) => rawErr(withCommand(value, command));
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
        ...(capabilities.columns ? { columns: capabilities.columns } : {}),
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
      "--affected",
      "experimental: send Git diff and test sources to Jev; run relevant tests",
      false,
    )
    .option("--base <ref>", "base ref for --affected (default main or master)")
    .option(
      "--threshold <probability>",
      "minimum relevance probability for --affected (default 0.1)",
      relevanceThreshold,
    )
    .option(
      "--selection-only",
      "with --affected, print selection JSON without running tests (calls Jev)",
      false,
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
    .option(
      "--id <id>",
      "select a test by its exact id (repeatable)",
      collectValue,
      [],
    )
    .option("--env <name>", "select a named environment")
    .option("--browser <kind>", "chrome or chromium")
    .option("--vision", "enable vision fallback for ambiguous clicks")
    .option("--no-vision", "disable vision fallback")
    .option("--vision-model <model>", "override the OpenRouter vision model")
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
    .option(
      "--parallel <n|auto>",
      "run tests in parallel lanes; auto uses half the CPU cores (default 1)",
      parallelValue,
    )
    .option(
      "--shard-index <index>",
      "run only this 1-based shard of the selection (with --shard-count)",
      positiveCount(10_000),
    )
    .option(
      "--shard-count <count>",
      "split the selection into this many deterministic shards",
      positiveCount(10_000),
    )
    .option(
      "--provider-concurrency <n>",
      "cap concurrent model-provider requests (default min(4, 2 x lanes))",
      positiveCount(32),
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
      "reporter: list, steps, terminal, json, markdown, or junit (repeatable or comma-separated; default list)",
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
      "\nPrerequisites:\n  Install Chromium with `sedum browsers install chromium` and set TYPESAFE_API_KEY (and TYPESAFE_BASE_URL for a compatible provider).\n\nExamples:\n  sedum run tests/login.test.ts\n  sedum run tests/login.test.ts --id 'tests/login.test.ts#signs in'\n  sedum run tests/login.test.yaml --strict --costs\n",
    )
    .action(
      async (
        paths: string[],
        options: {
          affected: boolean;
          base?: string;
          threshold?: number;
          selectionOnly: boolean;
          include: string[];
          exclude: string[];
          labels: string[];
          name: string[];
          id: string[];
          env?: string;
          browser?: string;
          vision?: boolean;
          visionModel?: string;
          urlOverride?: string;
          outputDir?: string;
          reporterDir?: string;
          reporter: string[];
          headed: boolean;
          slow?: number;
          retries: number;
          timeoutMinutes?: number;
          parallel?: ParallelRequest;
          shardIndex?: number;
          shardCount?: number;
          providerConcurrency?: number;
          replay: boolean;
          evidence: boolean;
          sensitiveOrigin: string[];
          strict: boolean;
          costs: boolean;
          locatorCache: boolean;
          locatorCacheCi: boolean;
        },
      ) => {
        if (
          (options.shardIndex === undefined) !==
            (options.shardCount === undefined) ||
          (options.shardIndex !== undefined &&
            options.shardIndex > options.shardCount!)
        ) {
          writeErr(
            renderDiagnostic({
              code: "invalid_shard",
              message:
                "--shard-index and --shard-count must be given together, with the index from 1 to the count.",
              fix: "Use --shard-index 1 --shard-count 4 through --shard-index 4 --shard-count 4.",
            }),
          );
          exitCode = 3;
          return;
        }
        if (options.affected && (options.shardCount ?? 1) > 1) {
          writeErr(
            renderDiagnostic({
              code: "affected_sharding_unsupported",
              message:
                "--affected cannot be combined with multiple shards: independent relevance selections can leave tests unexecuted.",
              fix: "Remove the shard options, or run without --affected. --parallel is supported.",
            }),
          );
          exitCode = 3;
          return;
        }
        if (
          !options.affected &&
          (options.base !== undefined ||
            options.threshold !== undefined ||
            options.selectionOnly)
        ) {
          writeErr(
            "--base, --threshold, and --selection-only require --affected.\n",
          );
          exitCode = 3;
          return;
        }
        if (options.affected) {
          const { selectAffectedTests, AffectedSelectionError } =
            await import("./affected-selection.js");
          const { ProviderError } = await import("@sedum-dev/core");
          writeErr(
            "Experimental selection sends the tracked Git diff and test/module sources to the configured TypeSafe provider. Full CI is still recommended.\n",
          );
          try {
            const selection = await selectAffectedTests({
              cwd,
              paths,
              filters: {
                include: options.include,
                exclude: options.exclude,
                labels: options.labels,
                names: options.name,
                ids: options.id,
              },
              threshold: options.threshold ?? 0.1,
              ...(options.base !== undefined ? { base: options.base } : {}),
              ...(options.env ? { environment: options.env } : {}),
              ...(runtime.signal ? { signal: runtime.signal } : {}),
              ...(runtime.createRelevanceProvider
                ? { createProvider: runtime.createRelevanceProvider }
                : {}),
            });
            paths = selection.tests
              .filter((test) => test.selected)
              .map((test) => test.file);
            if (options.selectionOnly) {
              writeOut(`${JSON.stringify(selection, null, 2)}\n`);
              exitCode = 0;
              return;
            }
            writeErr(
              `Affected selection: ${paths.length}/${selection.tests.length} tests, threshold ${selection.threshold}, base ${selection.base}.\n`,
            );
            for (const test of selection.tests)
              writeErr(
                `${test.selected ? "RUN " : "SKIP"} ${test.probability.toFixed(4)} ${JSON.stringify(test.file)} (${test.reason})\n`,
              );
            if (!paths.length) {
              writeErr("No relevant tests selected; no tests were executed.\n");
              exitCode = 0;
              return;
            }
          } catch (error) {
            writeErr(
              `${error instanceof AffectedSelectionError || error instanceof ProviderError ? error.message : "Affected selection could not complete."}\nNo tests were run. Fix the selection error or run without --affected.\n`,
            );
            exitCode = 3;
            return;
          }
        }
        const lifecycle = new ReporterLifecycle();
        const terminalNames = options.reporter.length
          ? options.reporter
              .filter(
                (name) =>
                  name !== "json" && name !== "markdown" && name !== "junit",
              )
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
          const lanes = snapshot.execution?.parallel.lanes ?? 1;
          const parallel =
            lanes > 1
              ? {
                  parallel: {
                    lanes,
                    total: snapshot.selectedTestCount ?? snapshot.tests.length,
                    retries: options.retries,
                  },
                }
              : {};
          for (const event of events)
            for (const [index, reporter] of reporters.entries()) {
              if (event.type === "runStarted" && index > 0) continue;
              const output = reporter.onEvent(event, {
                ...context(artifacts),
                ...parallel,
              });
              if (output) writeOut(output);
            }
        };
        const execution = await executeRun({
          command,
          ...(runtime.onStrayRejection
            ? { onStrayRejection: runtime.onStrayRejection }
            : {}),
          paths,
          filters: {
            include: options.include,
            exclude: options.exclude,
            labels: options.labels,
            names: options.name,
            ids: options.id,
          },
          ...(options.env ? { environment: options.env } : {}),
          ...(options.browser ? { browser: options.browser } : {}),
          ...(options.vision !== undefined ? { vision: options.vision } : {}),
          ...(options.visionModel !== undefined
            ? { visionModel: options.visionModel }
            : {}),
          ...(options.urlOverride ? { urlOverride: options.urlOverride } : {}),
          ...(options.outputDir ? { outputDir: options.outputDir } : {}),
          ...(options.reporterDir ? { reporterDir: options.reporterDir } : {}),
          reporters: options.reporter,
          strict: options.strict,
          headed: options.headed,
          ...(options.slow !== undefined ? { slowMoMs: options.slow } : {}),
          retries: options.retries,
          ...(options.parallel !== undefined
            ? { parallel: options.parallel }
            : {}),
          ...(options.shardIndex !== undefined &&
          options.shardCount !== undefined
            ? {
                shard: {
                  index: options.shardIndex,
                  count: options.shardCount,
                },
              }
            : {}),
          ...(options.providerConcurrency !== undefined
            ? { providerConcurrency: options.providerConcurrency }
            : {}),
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
        // Without a terminal reporter, still say where the agent report is,
        // and the JUnit file beside it for a CI step reading both.
        if (
          !reporters.length &&
          execution.artifacts.authoritative &&
          execution.artifacts.markdownPath
        ) {
          writeOut(`markdown ${execution.artifacts.markdownPath}\n`);
          if (execution.artifacts.junitPath)
            writeOut(`junit ${execution.artifacts.junitPath}\n`);
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
    .option(
      "--vision",
      "also check the vision fallback's OPEN_ROUTER_API_KEY (automatic when vision.enabled is true)",
      false,
    )
    .addHelpText(
      "after",
      "\nThe authenticated API check makes one small, potentially billable request.\n\nExit codes:\n  0 all checks passed\n  3 one or more prerequisites failed\n",
    )
    .action(async (options: { json: boolean; vision: boolean }) => {
      const { executeDoctorCommand, renderDoctorText } =
        await import("./doctor-command.js");
      const result = await executeDoctorCommand(cwd, runtime.doctorProbes, {
        vision: options.vision,
      });
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
      "classify sentences the offline cache cannot, using the configured provider API key, and update .sedum/classifications.json",
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
