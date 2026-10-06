import type { RunResult } from "@sedum-dev/core";
import path from "node:path";
import type { ResolvedProjectConfig } from "../config.js";
import type { RunCommandOptions } from "../run-command.js";
import { discoverRunTests } from "../run-selection.js";
import { shardProblems, shardTests } from "../run-shard.js";

export interface RunDiscovery {
  readonly files: readonly { readonly file: string; readonly id: string }[];
  readonly globalSelectedTests: number;
  readonly problems: NonNullable<RunResult["discoveryProblems"]>;
}

export async function discoverCommandTests(
  config: ResolvedProjectConfig,
  options: RunCommandOptions,
  safeText: (value: string) => string,
): Promise<RunDiscovery> {
  const selection = await discoverRunTests(
    config,
    options.paths ?? (options.file ? [options.file] : []),
    options.filters,
  );
  const selected = options.shard
    ? shardTests(selection.tests, options.shard)
    : selection.tests;
  const files = selected.map((test) => ({
    file: path.join(config.projectRoot, test.file),
    id: test.id,
  }));
  const problems = [
    ...selection.problems,
    ...selection.invalid.flatMap((entry) =>
      entry.diagnostics.map((item) => ({
        file: entry.file,
        line: item.line,
        col: item.col,
        code: item.code,
        message: safeText(item.message),
        fix: safeText(item.fix),
      })),
    ),
  ];
  return {
    files,
    globalSelectedTests: selection.tests.length,
    problems: options.shard ? shardProblems(problems, options.shard) : problems,
  };
}
