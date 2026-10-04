import type { BrowserPage } from "./browser-driver.js";
import { pageVersion } from "./page-bridge.js";
import type { PageVersion } from "./page-protocol.js";
import { safeUrl, type ReportPrivacy } from "./report-privacy.js";
import type { ResultFrame } from "./run-result.js";

interface StableFrameRequest {
  readonly page: BrowserPage;
  readonly privacy: ReportPrivacy;
  readonly save: (bytes: Uint8Array) => Promise<ResultFrame>;
  readonly sensitive: boolean;
  readonly enabled?: boolean;
  readonly expectedVersion?: PageVersion | null;
}

const sameVersion = (left: PageVersion, right: PageVersion): boolean =>
  left.document === right.document &&
  left.revision === right.revision &&
  left.route === right.route;

function capturedVersionProblem(
  version: PageVersion,
  privacy: ReportPrivacy,
  expectedVersion: PageVersion | null | undefined,
): ResultFrame | null {
  if (expectedVersion === null)
    return { status: "unavailable", reason: "stale_frame" };
  if (expectedVersion && !sameVersion(version, expectedVersion))
    return { status: "unavailable", reason: "stale_frame" };
  if (safeUrl(version.route, privacy).sensitive)
    return { status: "omitted", reason: "sensitive_page" };
  return null;
}

export async function captureStableGoalFrame({
  page,
  privacy,
  save,
  sensitive,
  enabled = true,
  expectedVersion,
}: StableFrameRequest): Promise<ResultFrame> {
  if (sensitive) return { status: "omitted", reason: "sensitive_page" };
  if (!enabled) return { status: "omitted", reason: "disabled" };
  if (!page.captureFrame)
    return { status: "unavailable", reason: "capture_unavailable" };
  try {
    const before = await pageVersion(page);
    const problem = capturedVersionProblem(before, privacy, expectedVersion);
    if (problem) return problem;
    const bytes = await page.captureFrame();
    const after = await pageVersion(page);
    if (!sameVersion(before, after))
      return { status: "unavailable", reason: "stale_frame" };
    return await save(bytes);
  } catch {
    return { status: "unavailable", reason: "capture_failed" };
  }
}
