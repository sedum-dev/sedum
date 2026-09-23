import {
  discoverProjectFiles,
  listTests,
  loadFlowFile,
  type ProjectFiles,
  type TestListing,
} from "@sedum-dev/core";

export interface ListCommandExecution {
  readonly discovery: ProjectFiles;
  readonly listing: TestListing | null;
}

/** Format-only: no module resolution, classification, cache, or provider. */
export async function executeListCommand(options: {
  readonly paths: readonly string[];
  readonly cwd: string;
}): Promise<ListCommandExecution> {
  const discovery = await discoverProjectFiles(options.paths, {
    repoRoot: options.cwd,
  });
  if (discovery.problems.length) return { discovery, listing: null };
  const parsed = [];
  for (const file of discovery.tests)
    parsed.push({
      file,
      result: await loadFlowFile(file, { repoRoot: discovery.root }),
    });
  return {
    discovery,
    listing: listTests(parsed, { repoRoot: discovery.root }),
  };
}
