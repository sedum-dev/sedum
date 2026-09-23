import {
  validateRunResult,
  type ProjectValidationResult,
  type RunResult,
  type TestListing,
} from "@sedum-dev/core";

export type SedumExitCode = 0 | 1 | 2 | 3;

/** SED-13 gating policy. This never changes the canonical result. */
export function runExitCode(result: RunResult, strict: boolean): SedumExitCode {
  const value = validateRunResult(result);
  if (
    value.state !== "completed" ||
    value.error !== null ||
    value.verdict === null ||
    value.totals.executedTests === 0
  )
    return 3;
  if (value.verdict === "failed") return 1;
  return strict && value.flags.length > 0 ? 2 : 0;
}

/**
 * `sedum validate`: 3 when the check could not run (usage, setup, provider or
 * file-read failure), which wins over findings; 1 for invalid content or
 * sentences not checkable offline; 0 only for a complete, clean validation.
 */
export function validateExitCode(
  result: ProjectValidationResult | null,
  failedBeforeChecks: boolean,
): SedumExitCode {
  if (failedBeforeChecks || !result || result.counts.operational > 0) return 3;
  if (!result.fullyValidated) return 1;
  return 0;
}

/** `sedum list`: 3 for usage problems, 1 when any file cannot be listed. */
export function listExitCode(
  listing: TestListing | null,
  failedBeforeListing: boolean,
): SedumExitCode {
  if (failedBeforeListing || !listing) return 3;
  return listing.invalid.length ? 1 : 0;
}
