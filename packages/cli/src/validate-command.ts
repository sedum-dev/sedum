import {
  discoverProjectFiles,
  FileClassificationCache,
  ProviderError,
  validateProject,
  type ClassificationProvider,
  type DiscoveryProblem,
  type ProjectFiles,
  type ProjectValidationResult,
} from "@sedum-dev/core";
import path from "node:path";
import type { CliDiagnostic } from "./diagnostics.js";

/** Must match the requested model `sedum run` stores classifications under. */
export const CLASSIFICATION_MODEL = "jev-latest";

export type ClassificationProviderFactory = () =>
  ClassificationProvider | Promise<ClassificationProvider>;

/** Loaded only for `--online`, so offline commands never touch the provider. */
export const createTypeSafeClassifier: ClassificationProviderFactory =
  async () => {
    const { TypeSafeAdapter } = await import("@sedum-dev/provider-typesafe");
    return new TypeSafeAdapter();
  };

export interface ValidateCommandOptions {
  readonly paths: readonly string[];
  readonly online: boolean;
  readonly cwd: string;
  readonly createProvider: ClassificationProviderFactory;
  readonly signal?: AbortSignal;
}

export interface ValidateCommandExecution {
  readonly discovery: ProjectFiles;
  /** Null when discovery or setup failed before any file was checked. */
  readonly result: ProjectValidationResult | null;
  /** A setup failure such as a missing key for `--online`. */
  readonly setup: CliDiagnostic | null;
}

export function emptyProjectProblem(
  paths: readonly string[],
): DiscoveryProblem {
  const shown = paths.length ? paths.join(", ") : ".";
  return {
    code: "missing_path",
    path: shown,
    message: `No *.test.yaml or *.module.yaml files were found under ${shown}.`,
    fix: "Pass the directory that contains your tests, or run the command from the project root.",
  };
}

export async function executeValidateCommand(
  options: ValidateCommandOptions,
): Promise<ValidateCommandExecution> {
  const discovery = await discoverProjectFiles(options.paths, {
    repoRoot: options.cwd,
  });
  if (discovery.problems.length)
    return { discovery, result: null, setup: null };
  if (!discovery.tests.length && !discovery.modules.length)
    return {
      discovery: {
        ...discovery,
        problems: [emptyProjectProblem(options.paths)],
      },
      result: null,
      setup: null,
    };
  let provider: ClassificationProvider | undefined;
  if (options.online)
    try {
      provider = await options.createProvider();
    } catch (error) {
      return {
        discovery,
        result: null,
        setup:
          error instanceof ProviderError && error.code === "configuration"
            ? {
                code: "missing_key",
                message:
                  "`sedum validate --online` needs a configured TypeSafe provider.",
                fix: "Set TYPESAFE_API_KEY and rerun, or omit --online to validate offline.",
              }
            : {
                code: "setup_error",
                message: "The classification provider could not be prepared.",
                fix: "Check the provider installation and configuration, then rerun.",
              },
      };
    }
  const cache = await FileClassificationCache.load(
    path.join(discovery.root, ".sedum", "classifications.json"),
    CLASSIFICATION_MODEL,
  );
  const result = await validateProject(discovery, {
    repoRoot: discovery.root,
    mode: options.online ? "allow-model" : "offline",
    cache,
    ...(provider ? { provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { discovery, result, setup: null };
}
