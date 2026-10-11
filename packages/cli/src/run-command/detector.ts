import { BugDetector, ProviderError, isPageInspector } from "@sedum-dev/core";
import type { RunCommandOptions } from "../run-command.js";

/** One detector per run, so lanes share its page-state cache. */
export function createDetector(
  options: Pick<RunCommandOptions, "detect" | "detectAllow">,
  provider: unknown,
): BugDetector | undefined {
  if (!options.detect || options.detect === "off") return undefined;
  const allow = options.detectAllow ?? [];
  if (options.detect === "browser") return new BugDetector({ allow });
  if (!isPageInspector(provider))
    throw new ProviderError(
      "configuration",
      "--detect semantic needs a System One provider (TypeSafe or OpenRouter). Use --detect browser with this provider.",
    );
  return new BugDetector({ allow, semantic: { inspector: provider } });
}
