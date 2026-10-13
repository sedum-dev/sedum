import { BugDetector, isPageInspector } from "@sedum-dev/core";
import { DetectorUnsupportedError } from "../diagnostics.js";
import type { RunCommandOptions } from "../run-command.js";

/** One detector per run, so lanes share its page-state cache. */
export function createDetector(
  options: Pick<RunCommandOptions, "detect" | "detectAllow">,
  provider: unknown,
  providerName: string,
): BugDetector | undefined {
  if (!options.detect || options.detect === "off") return undefined;
  const allow = options.detectAllow ?? [];
  if (options.detect === "browser") return new BugDetector({ allow });
  if (!isPageInspector(provider))
    throw new DetectorUnsupportedError(providerName);
  return new BugDetector({ allow, semantic: { inspector: provider } });
}
