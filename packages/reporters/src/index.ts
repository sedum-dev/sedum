import type { RunResult } from "@sedum-dev/core";
import { validateRunResult } from "@sedum-dev/core";

/** Reporter implementations will consume the single core result contract. */
export type ReportInput = RunResult;

/** The JSON reporter serializes the canonical result without reinterpreting it. */
export function renderJson(result: RunResult): string {
  return `${JSON.stringify(validateRunResult(result), null, 2)}\n`;
}

export { renderHtml } from "./html.js";
export type { HtmlReportOptions } from "./html.js";

export { ReporterLifecycle } from "./lifecycle.js";
export type { ReporterEvent } from "./lifecycle.js";
export { createTerminalReporter } from "./terminal.js";
export type {
  Reporter,
  ReporterContext,
  TerminalReporterName,
} from "./terminal.js";
export { renderMarkdown } from "./markdown.js";
export {
  needsAttention,
  runIsTrustworthy,
  score,
  testOrder,
  testStatus,
  testStatusLabel,
} from "./shared.js";
export type { TestStatus } from "./shared.js";
export { renderJunit } from "./junit.js";
export type { JunitReportOptions } from "./junit.js";
