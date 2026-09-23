import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  discoverProjectFiles,
  walkSuiteFiles,
  type ProjectFiles,
} from "@sedum-dev/core";
import {
  discoverConfiguredTests,
  loadProjectConfig,
  ProjectConfigError,
  type ConfigDiagnostic,
  type ResolvedProjectConfig,
} from "./config.js";

export type ProjectContext =
  | {
      readonly config: ResolvedProjectConfig;
      readonly discovery: ProjectFiles;
      readonly configErrors: readonly [];
    }
  | {
      readonly config: null;
      readonly discovery: null;
      readonly configErrors: readonly ConfigDiagnostic[];
    };

/**
 * Resolve the project the way `sedum run` does, without reading `.env` or the
 * process environment. Explicit paths resolve against the project root; with
 * none, tests come from `tests.directory` and its include/exclude globs, and
 * modules from `*.module.yaml` files under that directory.
 */
export async function loadProjectContext(
  paths: readonly string[],
  cwd: string,
): Promise<ProjectContext> {
  let config: ResolvedProjectConfig;
  try {
    config = await loadProjectConfig(
      cwd,
      {},
      {},
      { readEnvironmentFile: false },
    );
  } catch (error) {
    return {
      config: null,
      discovery: null,
      configErrors:
        error instanceof ProjectConfigError
          ? error.diagnostics
          : [
              {
                code: "config_error",
                file: path.join(cwd, "sedum.config.yaml"),
                line: 1,
                col: 1,
                key: "<file>",
                message: "The Sedum configuration could not be loaded.",
                fix: "Check sedum.config.yaml and its permissions, then rerun.",
              },
            ],
    };
  }
  if (paths.length)
    return {
      config,
      discovery: await discoverProjectFiles(paths, {
        repoRoot: config.projectRoot,
      }),
      configErrors: [],
    };

  const root = await realpath(config.projectRoot).catch(
    () => config.projectRoot,
  );
  // Keep one spelling under the real root so identities and module
  // reachability match explicit-path discovery.
  const under = (file: string) =>
    path.join(root, path.relative(config.projectRoot, file));
  const testDirectory = path.relative(config.projectRoot, config.testDirectory);
  let tests: readonly string[];
  let unreadable = false;
  try {
    tests = await discoverConfiguredTests(config);
  } catch {
    tests = [];
    unreadable = true;
  }
  // Like configured test discovery, a missing test directory has no files.
  const exists = await stat(config.testDirectory).then(
    () => true,
    () => false,
  );
  const modules = exists
    ? await walkSuiteFiles(config.testDirectory, [".module.yaml"], () => {
        unreadable = true;
      })
    : [];
  return {
    config,
    discovery: {
      root,
      tests: tests.map(under),
      modules: modules.map(under),
      problems: unreadable
        ? [
            {
              code: "unreadable_directory",
              path: testDirectory || ".",
              message: `Could not read the configured test directory ${testDirectory || "."}.`,
              fix: "Check tests.directory in sedum.config.yaml and the directory permissions.",
            },
          ]
        : [],
    },
    configErrors: [],
  };
}

/** `file:line:col: error code: message` plus a fix, for stderr. */
export function renderConfigErrors(
  errors: readonly ConfigDiagnostic[],
  cwd: string,
): string {
  return errors
    .map((item) => {
      const file = path.relative(cwd, item.file).split(path.sep).join("/");
      return `${file}:${item.line}:${item.col}: error ${item.code}: ${item.message}\nFix: ${item.fix}\n`;
    })
    .join("");
}
