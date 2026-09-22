import type { RunResult } from "@sedum-dev/core";
import { validateRunResult } from "@sedum-dev/core";

/** Reporter implementations will consume the single core result contract. */
export type ReportInput = RunResult;

/** The JSON reporter serializes the canonical result without reinterpreting it. */
export function renderJson(result: RunResult): string {
  return `${JSON.stringify(validateRunResult(result), null, 2)}\n`;
}
