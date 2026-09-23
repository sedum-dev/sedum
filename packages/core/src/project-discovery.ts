import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type DiscoveryProblemCode =
  "missing_path" | "outside_root" | "unsupported_file" | "unreadable_directory";

/** A usage problem with a requested path; never a finding about test content. */
export interface DiscoveryProblem {
  readonly code: DiscoveryProblemCode;
  readonly path: string;
  readonly message: string;
  readonly fix: string;
}

export interface ProjectFiles {
  /** The real path of the project root; every returned file lies under it. */
  readonly root: string;
  readonly tests: readonly string[];
  readonly modules: readonly string[];
  readonly problems: readonly DiscoveryProblem[];
}

const TEST_SUFFIX = ".test.yaml";
const MODULE_SUFFIX = ".module.yaml";

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Dependency folders and dot-directories below a root are never suites. */
function ignoredDirectory(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

/**
 * Recursively list files with one of the suffixes, sorted by path. Symlinked
 * entries are not followed. Unreadable subdirectories are reported, not thrown.
 */
export async function walkSuiteFiles(
  directory: string,
  suffixes: readonly string[],
  onUnreadable: (folder: string) => void = () => undefined,
): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(folder: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      onUnreadable(folder);
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectory(entry.name)) await visit(entryPath);
      } else if (
        entry.isFile() &&
        suffixes.some((suffix) => entry.name.endsWith(suffix))
      )
        files.push(entryPath);
    }
  }
  await visit(directory);
  return files.sort();
}

/**
 * Resolve CLI paths into test and module files under the project root.
 * Containment uses real paths so symlinked checkouts and `/var` vs
 * `/private/var` spellings never make an inside path look outside.
 */
export async function discoverProjectFiles(
  paths: readonly string[],
  options: { readonly repoRoot: string },
): Promise<ProjectFiles> {
  const requestedRoot = path.resolve(options.repoRoot);
  const root = await realpath(requestedRoot).catch(() => requestedRoot);
  const tests = new Set<string>();
  const modules = new Set<string>();
  const problems: DiscoveryProblem[] = [];
  const outside = (requested: string) =>
    problems.push({
      code: "outside_root",
      path: requested,
      message: `${requested} is outside the project root ${root}.`,
      fix: "Run the command from the project root, or pass paths inside it.",
    });
  const add = (file: string) => {
    if (file.endsWith(TEST_SUFFIX)) tests.add(file);
    else modules.add(file);
  };

  for (const requested of paths.length ? paths : ["."]) {
    const absolute = path.resolve(requestedRoot, requested);
    let kind: "directory" | "file";
    try {
      kind = (await stat(absolute)).isDirectory() ? "directory" : "file";
    } catch {
      problems.push({
        code: "missing_path",
        path: requested,
        message: `${requested} does not exist.`,
        fix: "Check the path and rerun the command.",
      });
      continue;
    }
    if (kind === "directory") {
      const real = await realpath(absolute);
      if (!contains(root, real)) {
        outside(requested);
        continue;
      }
      const found = await walkSuiteFiles(
        real,
        [TEST_SUFFIX, MODULE_SUFFIX],
        (folder) =>
          problems.push({
            code: "unreadable_directory",
            path: path.relative(root, folder) || ".",
            message: `Could not read the directory ${path.relative(root, folder) || "."}.`,
            fix: "Check the directory permissions and rerun the command.",
          }),
      );
      found.forEach(add);
      continue;
    }
    const name = path.basename(absolute);
    if (!name.endsWith(TEST_SUFFIX) && !name.endsWith(MODULE_SUFFIX)) {
      problems.push({
        code: "unsupported_file",
        path: requested,
        message: `${requested} is not a *.test.yaml or *.module.yaml file.`,
        fix: "Pass a test file, a module file, or a directory.",
      });
      continue;
    }
    // A test keeps its link name as identity, as `sedum run` does. A module is
    // reached through real paths, so it is fully resolved to match that check.
    const file = name.endsWith(MODULE_SUFFIX)
      ? await realpath(absolute)
      : path.join(await realpath(path.dirname(absolute)), name);
    if (!contains(root, file)) {
      outside(requested);
      continue;
    }
    add(file);
  }

  const byPath = (a: string, b: string) => {
    const left = path.relative(root, a);
    const right = path.relative(root, b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  return {
    root,
    tests: [...tests].sort(byPath),
    modules: [...modules].sort(byPath),
    problems,
  };
}
