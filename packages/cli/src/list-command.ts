import {
  listTests,
  loadFlowFile,
  type ProjectFiles,
  type TestListing,
} from "@sedum-dev/core";
import type { ConfigDiagnostic } from "./config.js";
import { loadProjectContext } from "./project-context.js";

export interface ListCommandExecution {
  /** Null when the project configuration could not be loaded. */
  readonly discovery: ProjectFiles | null;
  readonly configErrors: readonly ConfigDiagnostic[];
  readonly listing: TestListing | null;
}

/** Format-only: no module resolution, classification, cache, or provider. */
export async function executeListCommand(options: {
  readonly paths: readonly string[];
  readonly cwd: string;
}): Promise<ListCommandExecution> {
  const context = await loadProjectContext(options.paths, options.cwd);
  if (!context.config)
    return {
      discovery: null,
      configErrors: context.configErrors,
      listing: null,
    };
  const { discovery } = context;
  if (discovery.problems.length)
    return { discovery, configErrors: [], listing: null };
  const parsed = [];
  for (const file of discovery.tests)
    parsed.push({
      file,
      result: await loadFlowFile(file, { repoRoot: discovery.root }),
    });
  return {
    discovery,
    configErrors: [],
    listing: listTests(parsed, { repoRoot: discovery.root }),
  };
}
