import path from "node:path";
import type { RunResult } from "@sedum-dev/core";
import { ProjectConfigError, type ResolvedProjectConfig } from "../config.js";
import { setupDiagnostic, type CliDiagnostic } from "../diagnostics.js";
import type { RunCommandOptions } from "../run-command.js";

type DiscoveryProblems = NonNullable<RunResult["discoveryProblems"]>;

export interface RunConclusion {
  readonly diagnostic: CliDiagnostic;
  readonly state?: "error" | "interrupted";
  readonly recordDiscoveryProblems?: boolean;
}

interface SelectionRequest {
  readonly config: ResolvedProjectConfig;
  readonly options: RunCommandOptions;
  readonly files: readonly unknown[];
  readonly globalSelectedTests: number;
  readonly problems: DiscoveryProblems;
  readonly aborted: boolean;
  readonly timedOut: boolean;
}

export function interruptionConclusion(timedOut: boolean): RunConclusion {
  return timedOut
    ? {
        diagnostic: {
          code: "run_timeout",
          message: "The run deadline expired.",
          fix: "Increase --timeout-minutes or reduce the selected suite.",
        },
        state: "error",
      }
    : {
        diagnostic: {
          code: "canceled",
          message: "The run was interrupted.",
          fix: "Rerun the command when you are ready to continue.",
        },
        state: "interrupted",
      };
}

export function selectionConclusion(
  request: SelectionRequest,
): RunConclusion | null {
  const {
    config,
    options,
    files,
    globalSelectedTests,
    problems,
    aborted,
    timedOut,
  } = request;
  if (aborted)
    return {
      ...interruptionConclusion(timedOut),
      recordDiscoveryProblems: problems.length > 0,
    };
  if (files.length > 0) return null;
  if (options.shard && globalSelectedTests > 0)
    return emptyShardConclusion(options.shard, globalSelectedTests, problems);
  if (problems.length > 0) return discoveryProblemConclusion(problems);
  return noTestsConclusion(config);
}

function emptyShardConclusion(
  shard: NonNullable<RunCommandOptions["shard"]>,
  globalSelectedTests: number,
  problems: DiscoveryProblems,
): RunConclusion {
  const { index, count } = shard;
  return {
    diagnostic: {
      code: "empty_shard",
      message: `Shard ${index}/${count} has no tests; the selection has ${globalSelectedTests} test${globalSelectedTests === 1 ? "" : "s"}.`,
      fix: `Use --shard-count ${globalSelectedTests} or fewer.`,
    },
    recordDiscoveryProblems: problems.length > 0,
  };
}

function discoveryProblemConclusion(
  problems: DiscoveryProblems,
): RunConclusion {
  const [first] = problems;
  return {
    diagnostic: {
      code: "discovery_error",
      message:
        problems.length === 1
          ? `${first!.file}: ${first!.message}`
          : `${problems.length} test file or path problem(s) were found; the first: ${first!.file}: ${first!.message}`,
      fix: first!.fix,
    },
    recordDiscoveryProblems: true,
  };
}

function noTestsConclusion(config: ResolvedProjectConfig): RunConclusion {
  const error = new ProjectConfigError([
    {
      code: "no_tests",
      file:
        config.configPath ?? path.join(config.projectRoot, "sedum.config.yaml"),
      line: 1,
      col: 1,
      key: "tests.include",
      message: "The selection matched no valid test files.",
      fix: "Add a matching *.test.ts or *.test.yaml file, or correct paths and filters.",
    },
  ]);
  return { diagnostic: setupDiagnostic(error) };
}

export function completedRunConclusion(
  operational: CliDiagnostic | null,
  erroredTests: number,
  discoveryProblems: DiscoveryProblems,
): CliDiagnostic | null {
  if (operational)
    return erroredTests > 1
      ? {
          code: "test_errors",
          message: `${erroredTests} tests could not run. First: ${operational.message}`,
          fix: "Fix the tests named under needs attention, then rerun them.",
        }
      : operational;
  if (discoveryProblems.length)
    return {
      code: "discovery_error",
      message: `${discoveryProblems.length} test file or path problem(s) were found.`,
      fix: "Correct the files named in the run summary and rerun.",
    };
  return null;
}
