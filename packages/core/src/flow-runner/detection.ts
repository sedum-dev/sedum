import type { BrowserPage } from "../browser-driver.js";
import type { Detection } from "../detector/checks.js";
import type { BugDetector } from "../detector/detector.js";
import { safeText, safeUrl, type ReportPrivacy } from "../report-privacy.js";
import type { ResultCall, ResultDetection } from "../run-result.js";
import { resultCall } from "./support.js";

export interface StepDetections {
  readonly detections: readonly ResultDetection[];
  /** Jev calls `--detect semantic` made for this step's page. */
  readonly calls: readonly ResultCall[];
}

const STEP_LIMIT = 50;
const SENSITIVE = "Details omitted on a sensitive page.";
/** Where an absolute URL starts inside browser text. */
const URL_START = /\b(?:https?|wss?):\/\//giu;
/** Sentence punctuation and the collector's clip marker are not part of a URL. */
const URL_TAIL = /[.,;:!?…]+$/u;
/** A URL quoted or bracketed in a message ends before the matching closer. */
const CLOSERS: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  "`": "`",
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
};

/**
 * Splits a whitespace-bounded token into the URL and what follows it. Only
 * sentence punctuation and the closer matching the character before the URL
 * are peeled off: `( ) [ ] { } '` are legal inside URLs, as in
 * `/wiki/Mercury_(planet)` or `?filter[status]=open`.
 */
function splitUrl(token: string, closer: string | undefined) {
  let url = token;
  let tail = "";
  let open = closer;
  for (;;) {
    const punctuation = URL_TAIL.exec(url)?.[0];
    if (punctuation) {
      url = url.slice(0, -punctuation.length);
      tail = punctuation + tail;
    } else if (open && url.endsWith(open)) {
      url = url.slice(0, -open.length);
      tail = open + tail;
      open = undefined;
    } else return { url, tail };
  }
}

function reduceUrl(raw: string, tail: string, privacy: ReportPrivacy): string {
  const safe = safeUrl(raw, privacy).url;
  // A bare origin stays bare; `safeUrl` would add the root path.
  const bare = !/^[a-z]+:\/\/[^/?#]*\//iu.test(raw);
  // A clip inside a query or fragment went with it.
  const rest = /[?#]/u.test(raw) ? tail.replace("…", "") : tail;
  return (bare ? safe.replace(/\/$/u, "") : safe) + rest;
}

/**
 * Every URL in a message is reduced like the step's own URL: origin and path
 * only, or the origin alone on a sensitive origin. Messages can hold URLs the
 * detection's `url` does not: a clipped one, or one Chrome quotes in a console
 * error, such as a request blocked by CORS. A URL nested in another's query
 * goes with that query.
 */
function safeUrls(text: string, privacy: ReportPrivacy): string {
  let reduced = "";
  let done = 0;
  for (const match of text.matchAll(URL_START)) {
    if (match.index < done) continue;
    const space = text.slice(match.index).search(/\s/u);
    const end = space < 0 ? text.length : match.index + space;
    const { url, tail } = splitUrl(
      text.slice(match.index, end),
      CLOSERS[text[match.index - 1] ?? ""],
    );
    reduced += text.slice(done, match.index) + reduceUrl(url, tail, privacy);
    done = end;
  }
  return reduced + text.slice(done);
}

/** Query strings and secrets never reach the report; sensitive pages keep only the check. */
function reportDetection(
  detection: Detection,
  privacy: ReportPrivacy,
  sensitive: boolean,
): ResultDetection {
  const url = detection.url ? safeUrl(detection.url, privacy).url : undefined;
  const message = sensitive ? SENSITIVE : safeUrls(detection.message, privacy);
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
  if (!detector) return { detections: [], calls: [] };
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
