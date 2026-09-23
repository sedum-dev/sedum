import { validateRunResult, type RunResult } from "@sedum-dev/core";

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
