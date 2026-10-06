import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  isScriptTestFile,
  loadFlowFile,
  ProviderError,
  resolveFlowModules,
} from "@sedum-dev/core";
import { loadProjectConfig, type ResolvedProjectConfig } from "./config.js";
import { providerDiagnostic } from "./diagnostics.js";
import { discoverRunTests, type RunFilters } from "./run-selection.js";
import {
  createCliProvider,
  type RelevanceProvider,
  type RelevanceTest,
} from "./provider-factory.js";

import {
  AffectedSelectionError,
  assertAffectedSnapshot,
  readBranchDiff,
  readCommittedSource,
} from "./affected-git.js";
export { AffectedSelectionError, readBranchDiff } from "./affected-git.js";
export type RelevanceProviderFactory = (
  config: ResolvedProjectConfig,
) => RelevanceProvider | Promise<RelevanceProvider>;

export async function selectAffectedTests(options: {
  cwd: string;
  paths: readonly string[];
  filters: RunFilters;
  threshold: number;
  base?: string;
  ignore?: readonly string[];
  environment?: string;
  signal?: AbortSignal;
  createProvider?: RelevanceProviderFactory;
}) {
  const config = await loadProjectConfig(options.cwd, process.env, {
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const canonicalProjectRoot = await realpath(config.projectRoot);
  const branch = await readBranchDiff(
    config.projectRoot,
    options.base,
    options.signal,
    [...config.affected.ignore, ...(options.ignore ?? [])],
  );
  const snapshot = {
    root: branch.root,
    head: branch.head,
    signal: options.signal,
  };
  const source = async (file: string) =>
    readCommittedSource(snapshot, await realpath(file));
  const selection = await discoverRunTests(
    config,
    options.paths,
    options.filters,
  );
  if (
    selection.invalid.length ||
    selection.problems.length ||
    !selection.tests.length
  )
    throw new AffectedSelectionError(
      "Test discovery is empty or invalid. Run sedum validate and fix discovery before using --affected.",
    );
  const changed = new Set(
    branch.changed.map((file) => path.resolve(branch.root, file)),
  );
  // Git names symlinks, while module dependencies use their canonical targets.
  // Keep lexical paths too: deleted files cannot be resolved.
  for (const file of [...changed])
    changed.add(await realpath(file).catch(() => file));
  const tests: RelevanceTest[] = [];
  const forced: boolean[] = [];
  for (const test of selection.tests) {
    const file = path.join(config.projectRoot, test.file);
    // A TypeScript file is scored once, by its source; selection runs the
    // whole file, and it has no modules.
    if (isScriptTestFile(file)) {
      if (tests.some((scored) => scored.file === test.file)) continue;
      forced.push(changed.has(await realpath(file)));
      tests.push({
        file: test.file,
        source: await source(file),
        modules: [],
      });
      continue;
    }
    const parsed = await loadFlowFile(file, {
      repoRoot: config.projectRoot,
      rejectSymlinks: true,
    });
    const resolved = await resolveFlowModules(parsed, {
      repoRoot: config.projectRoot,
    });
    if (
      !resolved.value ||
      resolved.diagnostics.some((item) => item.severity === "error")
    )
      throw new AffectedSelectionError(
        "A test or module is invalid. Run sedum validate before using --affected.",
      );
    const files = [await realpath(file), ...resolved.moduleFiles];
    forced.push(files.some((source) => changed.has(source)));
    tests.push({
      file: test.file,
      source: await source(file),
      modules: await Promise.all(
        resolved.moduleFiles.map(async (module) => ({
          file: path
            .relative(canonicalProjectRoot, module)
            .split(path.sep)
            .join("/"),
          source: await source(module),
        })),
      ),
    });
  }
  options.signal?.throwIfAborted();
  await assertAffectedSnapshot(snapshot);
  const candidates = tests.filter((_, index) => !forced[index]);
  let scores: Awaited<ReturnType<RelevanceProvider["scoreRelevance"]>>;
  try {
    scores =
      branch.diff && candidates.length
        ? await (
            options.createProvider
              ? await options.createProvider(config)
              : await createCliProvider(config)
          ).scoreRelevance(
            branch.diff,
            candidates,
            options.signal ? { signal: options.signal } : undefined,
          )
        : { probabilities: candidates.map(() => 0), calls: [], chunkCount: 0 };
  } catch (error) {
    if (
      error instanceof ProviderError &&
      (error.code === "authentication" || error.code === "configuration")
    ) {
      const diagnostic = providerDiagnostic(config.providerName, error.code);
      throw new AffectedSelectionError(
        `${diagnostic.message}\nFix: ${diagnostic.fix}`,
      );
    }
    throw error;
  }
  let candidateIndex = 0;
  const probabilities = tests.map((_, index) =>
    forced[index] ? 1 : scores.probabilities[candidateIndex++]!,
  );
  return {
    base: branch.base,
    head: branch.head,
    mergeBase: branch.mergeBase,
    changedFiles: branch.changed,
    ignoredFiles: branch.ignoredFiles,
    chunkCount: scores.chunkCount ?? (scores.calls.length ? 1 : 0),
    aggregation: "max" as const,
    threshold: options.threshold,
    calls: scores.calls,
    tests: tests.map((test, index) => ({
      file: test.file,
      probability: probabilities[index]!,
      selected:
        forced[index] ||
        (branch.diff !== "" && probabilities[index]! >= options.threshold),
      reason: forced[index]
        ? "test-or-module-changed"
        : branch.diff
          ? "model"
          : branch.ignoredFiles.length
            ? "all-ignored"
            : "no-diff",
    })),
  };
}
