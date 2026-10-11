import type { BrowserPage } from "../browser-driver.js";
import type { Detection } from "../detector/checks.js";
import type { BugDetector } from "../detector/detector.js";
import { safeText, safeUrl, type ReportPrivacy } from "../report-privacy.js";
import type { ResultCall, ResultDetection } from "../run-result.js";
import { resultCall } from "./support.js";

export interface StepDetections {
  readonly detections: readonly ResultDetection[];
  readonly calls: readonly ResultCall[];
}

const NONE: StepDetections = { detections: [], calls: [] };
const STEP_LIMIT = 50;

const SENSITIVE = "Details omitted on a sensitive page.";

/** Query strings and secrets never reach the report; sensitive pages keep only the check. */
function reportDetection(
  detection: Detection,
  privacy: ReportPrivacy,
  sensitive: boolean,
): ResultDetection {
  const url = detection.url ? safeUrl(detection.url, privacy).url : undefined;
  const message = sensitive
    ? SENSITIVE
    : detection.url
      ? detection.message.split(detection.url).join(url)
      : detection.message;
  return {
    ...detection,
    message: safeText(message, privacy, 512),
    ...(url === undefined ? {} : { url }),
  };
}

/** @internal Run the bug detector for the state a step left behind. */
export async function detectStep(
  page: BrowserPage,
  detector: BugDetector | undefined,
  report: { readonly privacy: ReportPrivacy; readonly sensitive: boolean },
  signal?: AbortSignal,
): Promise<StepDetections> {
  if (!detector) return NONE;
  const found = await detector.inspectStep(page, signal ? { signal } : {});
  return {
    detections: found.detections
      .slice(0, STEP_LIMIT)
      .map((detection) =>
        reportDetection(detection, report.privacy, report.sensitive),
      ),
    calls: found.calls.map(({ call, apiMs }) =>
      resultCall(call, "detector", apiMs),
    ),
  };
}
