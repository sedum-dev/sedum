import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  isScriptTestFile,
  loadFlowFile,
  resolveFlowModules,
} from "@sedum-dev/core";
import { loadProjectConfig, type ResolvedProjectConfig } from "./config.js";
import { discoverRunTests, type RunFilters } from "./run-selection.js";
import {
  createCliProvider,
  type RelevanceProvider,
  type RelevanceTest,
} from "./provider-factory.js";

const exec = promisify(execFile);
export class AffectedSelectionError extends Error {}
export type RelevanceProviderFactory = (
  config: ResolvedProjectConfig,
) => RelevanceProvider | Promise<RelevanceProvider>;

/** No shell, fetch, checkout, or index mutation. Compare the merge base to the working tree. */
export async function readBranchDiff(
  cwd: string,
  base?: string,
  signal?: AbortSignal,
) {
  const git = async (...args: string[]) =>
    (
      await exec("git", args, {
        cwd,
        maxBuffer: 2 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      })
    ).stdout;
  try {
    const root = (await git("rev-parse", "--show-toplevel")).trim();
    let reference = base;
    if (!reference) {
      for (const candidate of [
        "refs/heads/main",
        "refs/remotes/origin/main",
        "refs/heads/master",
        "refs/remotes/origin/master",
      ]) {
        try {
          await git(
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${candidate}^{commit}`,
          );
          reference = candidate;
          break;
        } catch {
          signal?.throwIfAborted();
        }
      }
    }
    if (!reference)
      throw new AffectedSelectionError(
        "No main or master ref found. Fetch the base branch or pass --base <ref>.",
      );
    const commit = (
      await git(
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${reference}^{commit}`,
      )
    ).trim();
    const mergeBase = (await git("merge-base", commit, "HEAD")).trim();
    if (
      (await git("ls-files", "--others", "--exclude-standard", "--", ":/"))
        .length
    )
      throw new AffectedSelectionError(
        "Untracked files are not represented in git diff. Stage intended files or ignore unrelated files before using --affected.",
      );
    const diff = await git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--no-relative",
      "--ignore-submodules=none",
      "--submodule=short",
      mergeBase,
      "--",
      ":/",
    );
    if (
      /^Binary files .* differ$/mu.test(diff) ||
      /^[+ -]Subproject commit /mu.test(diff)
    )
      throw new AffectedSelectionError(
        "Binary or submodule changes cannot be scored reliably. Run the full suite without --affected.",
      );
    const changed = (
      await git(
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-only",
        "--no-renames",
        "--no-relative",
        "--ignore-submodules=none",
        "-z",
        mergeBase,
        "--",
        ":/",
      )
    )
      .split("\0")
      .filter(Boolean);
    return { root, base: reference, mergeBase, diff, changed };
  } catch (error) {
    if (error instanceof AffectedSelectionError) throw error;
    throw new AffectedSelectionError(
      "Could not read a complete Git diff. Check the base ref and merge-base history (fetch deeper for shallow clones), or run without --affected.",
    );
  }
}

export async function selectAffectedTests(options: {
  cwd: string;
  paths: readonly string[];
  filters: RunFilters;
  threshold: number;
  base?: string;
  environment?: string;
  signal?: AbortSignal;
  createProvider?: RelevanceProviderFactory;
}) {
  const config = await loadProjectConfig(options.cwd, process.env, {
    ...(options.environment ? { environment: options.environment } : {}),
  });
  const canonicalProjectRoot = await realpath(config.projectRoot);
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
  const branch = await readBranchDiff(
    config.projectRoot,
    options.base,
    options.signal,
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
        source: await readFile(file, "utf8"),
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
      source: await readFile(file, "utf8"),
      modules: await Promise.all(
        resolved.moduleFiles.map(async (module) => ({
          file: path
            .relative(canonicalProjectRoot, module)
            .split(path.sep)
            .join("/"),
          source: await readFile(module, "utf8"),
        })),
      ),
    });
  }
  options.signal?.throwIfAborted();
  const scores = branch.diff
    ? await (
        options.createProvider
          ? await options.createProvider(config)
          : await createCliProvider(config)
      ).scoreRelevance(
        branch.diff,
        tests,
        options.signal ? { signal: options.signal } : undefined,
      )
    : { probabilities: tests.map(() => 0), calls: [] };
  return {
    base: branch.base,
    mergeBase: branch.mergeBase,
    threshold: options.threshold,
    calls: scores.calls,
    tests: tests.map((test, index) => ({
      file: test.file,
      probability: scores.probabilities[index]!,
      selected:
        branch.diff !== "" &&
        (forced[index] || scores.probabilities[index]! >= options.threshold),
      reason: forced[index]
        ? "test-or-module-changed"
        : branch.diff
          ? "model"
          : "no-diff",
    })),
  };
}
