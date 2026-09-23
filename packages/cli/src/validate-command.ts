import {
  FileClassificationCache,
  ProviderError,
  validateProject,
  type ClassificationProvider,
  type DiscoveryProblem,
  type ProjectFiles,
  type ProjectValidationResult,
} from "@sedum-dev/core";
import path from "node:path";
import { loadProjectConfig, type ConfigDiagnostic } from "./config.js";
import type { CliDiagnostic } from "./diagnostics.js";
import { loadProjectContext } from "./project-context.js";

/** Must match the requested model `sedum run` stores classifications under. */
export const CLASSIFICATION_MODEL = "jev-latest";

export type ClassificationProviderFactory = (options: {
  readonly apiKey?: string;
}) => ClassificationProvider | Promise<ClassificationProvider>;

/** Loaded only for `--online`, so offline commands never touch the provider. */
export const createTypeSafeClassifier: ClassificationProviderFactory = async ({
  apiKey,
}) => {
  const { TypeSafeAdapter } = await import("@sedum-dev/provider-typesafe");
  return new TypeSafeAdapter(apiKey ? { apiKey } : {});
};

export interface ValidateCommandOptions {
  readonly paths: readonly string[];
  readonly online: boolean;
  readonly cwd: string;
  readonly createProvider: ClassificationProviderFactory;
  readonly signal?: AbortSignal;
}

export interface ValidateCommandExecution {
  /** Null when the project configuration could not be loaded. */
  readonly discovery: ProjectFiles | null;
  readonly configErrors: readonly ConfigDiagnostic[];
  /** Null when configuration, discovery, or setup failed before checking. */
  readonly result: ProjectValidationResult | null;
  /** A setup failure such as a missing key for `--online`. */
  readonly setup: CliDiagnostic | null;
}

function emptyProjectProblem(
  paths: readonly string[],
  testDirectory: string,
): DiscoveryProblem {
  const shown = paths.length ? paths.join(", ") : testDirectory || ".";
  return {
    code: "missing_path",
    path: shown,
    message: `No *.test.yaml or *.module.yaml files were found under ${shown}.`,
    fix: paths.length
      ? "Pass paths relative to the project root that contain tests or modules."
      : "Add tests under tests.directory, or correct tests.directory/include/exclude in sedum.config.yaml.",
  };
}

const missingKey: CliDiagnostic = {
  code: "missing_key",
  message: "`sedum validate --online` needs a configured TypeSafe provider.",
  fix: "Set TYPESAFE_API_KEY in the environment or the project-root .env and rerun, or omit --online to validate offline.",
};

async function onlineProvider(
  options: ValidateCommandOptions,
): Promise<ClassificationProvider | CliDiagnostic> {
  try {
    // Only the explicit online path reads secrets: process env and .env.
    const { apiKey } = await loadProjectConfig(options.cwd);
    return await options.createProvider(apiKey ? { apiKey } : {});
  } catch (error) {
    if (error instanceof ProviderError && error.code === "configuration")
      return missingKey;
    return {
      code: "setup_error",
      message: "The classification provider could not be prepared.",
      fix: "Check the provider installation, sedum.config.yaml, and the project-root .env, then rerun.",
    };
  }
}

export async function executeValidateCommand(
  options: ValidateCommandOptions,
): Promise<ValidateCommandExecution> {
  const context = await loadProjectContext(options.paths, options.cwd);
  if (!context.config)
    return {
      discovery: null,
      configErrors: context.configErrors,
      result: null,
      setup: null,
    };
  const { config, discovery } = context;
  const stop = (
    files: ProjectFiles,
    setup: CliDiagnostic | null,
  ): ValidateCommandExecution => ({
    discovery: files,
    configErrors: [],
    result: null,
    setup,
  });
  if (discovery.problems.length) return stop(discovery, null);
  if (!discovery.tests.length && !discovery.modules.length)
    return stop(
      {
        ...discovery,
        problems: [
          emptyProjectProblem(
            options.paths,
            path.relative(config.projectRoot, config.testDirectory),
          ),
        ],
      },
      null,
    );
  let provider: ClassificationProvider | undefined;
  if (options.online) {
    const prepared = await onlineProvider(options);
    if ("code" in prepared) return stop(discovery, prepared);
    provider = prepared;
  }
  const cache = await FileClassificationCache.load(
    path.join(discovery.root, ".sedum", "classifications.json"),
    CLASSIFICATION_MODEL,
  );
  const result = await validateProject(discovery, {
    repoRoot: discovery.root,
    baseUrl: config.baseUrl,
    mode: options.online ? "allow-model" : "offline",
    cache,
    ...(provider ? { provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { discovery, configErrors: [], result, setup: null };
}
