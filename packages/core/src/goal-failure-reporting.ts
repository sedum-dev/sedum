import type { BrowserPage } from "./browser-driver.js";
import type { GoalResult } from "./goal-runner.js";
import { captureStableGoalFrame } from "./goal-reporting-capture.js";
import type { AttemptReport } from "./flow-runner/contracts.js";
import { reportPage, safeText, safeUrl } from "./report-privacy.js";
import type { ResultStep } from "./run-result.js";

/** Capture the current safe page and selected target for a terminal goal failure. */
export async function goalFailureArtifacts(
  page: BrowserPage,
  result: GoalResult,
  report: AttemptReport,
  id: string,
): Promise<
  Pick<ResultStep, "page" | "locator" | "evidence" | "targetBox"> & {
    readonly detail?: string;
  }
> {
  const context = result.failure;
  const sensitive =
    safeUrl(page.url, report.privacy).sensitive ||
    (context
      ? safeUrl(context.version.route, report.privacy).sensitive
      : false);
  const reportedPage = sensitive
    ? ({ status: "omitted", reason: "sensitive_page" } as const)
    : await reportPage(
        page,
        `${id}:observation:1`,
        report.privacy,
        context?.version,
      );
  const evidence = await captureStableGoalFrame({
    page,
    privacy: report.privacy,
    sensitive,
    enabled: report.evidenceEnabled,
    expectedVersion: context?.version ?? null,
    save: (bytes) =>
      report.saveFrame(report.test.currentAttempt!, `${id}:evidence`, bytes),
  });
  const locator =
    reportedPage.status === "available" &&
    context?.targetName &&
    context.targetRole
      ? {
          confidence: context.confidence ?? null,
          source: "model" as const,
          cache: null,
          options: [
            {
              label: safeText(context.targetName, report.privacy, 120),
              role: safeText(context.targetRole, report.privacy, 80),
              probability: context.probability ?? 0,
            },
          ],
        }
      : null;
  const detail = sensitive
    ? `The goal stopped on a sensitive page; page and target context were omitted.${context?.generator ? ` The retained synthetic value came from ${context.generator}; its value remains hidden.` : ""}`
    : result.detail;
  return {
    page: reportedPage,
    locator,
    evidence,
    targetBox: null,
    ...(detail ? { detail } : {}),
  };
}
