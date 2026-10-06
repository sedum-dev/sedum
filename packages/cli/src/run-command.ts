import type { RunResult, VisionKeyProbe } from "@sedum-dev/core";
import type { RunArtifactPaths } from "./output.js";
import type { ParallelRequest } from "./run-pool.js";
import type { RunFilters } from "./run-selection.js";
import type { ShardSpec } from "./run-shard.js";
import type { CliDiagnostic } from "./diagnostics.js";
import { executeRunCommandImplementation } from "./run-command/implementation.js";

export {
  verifyGraceMs,
  strayRejectionDiagnostic,
} from "./run-command/support.js";

export interface RunCommandOptions {
  /**
   * Receives a stray rejection from test code that arrived after the run was
   * reported; the `sedum` binary prints it and fails the exit code.
   */
  readonly onStrayRejection?: (message: string) => void;
  readonly file?: string;
  readonly paths?: readonly string[];
  readonly filters?: RunFilters;
  readonly environment?: string;
  readonly browser?: string;
  readonly vision?: boolean;
  readonly visionModel?: string;
  readonly urlOverride?: string;
  readonly outputDir?: string;
  readonly reporterDir?: string;
  readonly reporters?: readonly string[];
  /** SED-13 strict gate; JUnit records it so the file matches the exit. */
  readonly strict?: boolean;
  readonly headed?: boolean;
  readonly slowMoMs?: number;
  readonly retries?: number;
  readonly timeoutMinutes?: number;
  /** `--parallel`; defaults to one lane. */
  readonly parallel?: ParallelRequest;
  /** `--shard-index`/`--shard-count`, validated by the caller. */
  readonly shard?: ShardSpec;
  /** `--provider-concurrency`; defaults to min(4, lanes x 2). */
  readonly providerConcurrency?: number;
  /** Injected for tests; defaults to `os.availableParallelism()`. */
  readonly availableParallelism?: number;
  /** Injected for tests; defaults to OpenRouter's unbilled key endpoint. */
  readonly probeVisionKey?: (apiKey: string) => Promise<VisionKeyProbe>;
  readonly replay: boolean;
  readonly evidence: boolean;
  readonly sensitiveOrigins: readonly string[];
  readonly locatorCacheDisabled?: boolean;
  readonly locatorCacheCi?: boolean;
  readonly signal?: AbortSignal;
  /** How to invoke sedum in report rerun hints, e.g. `npx sedum`. */
  readonly command?: string;
  readonly onSnapshot?: (
    snapshot: RunResult,
    artifacts: RunArtifactPaths,
  ) => void;
  readonly onCommitted?: () => void;
  readonly onDeadline?: () => void;
}

export interface RunCommandExecution {
  readonly result: RunResult;
  readonly artifacts: RunArtifactPaths;
  readonly diagnostic: CliDiagnostic | null;
  readonly reporterFailed?: boolean;
  readonly onReporterFailure?: () => Promise<RunCommandExecution>;
}

export function executeRunCommand(
  options: RunCommandOptions,
): Promise<RunCommandExecution> {
  return executeRunCommandImplementation(options);
}
