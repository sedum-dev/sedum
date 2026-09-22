import path from "node:path";
import type { BrowserPage } from "./browser-driver.js";
import { pageVersion } from "./page-bridge.js";
import type { PageVersion } from "./page-protocol.js";
import type { FlowSource } from "./flow-types.js";
import type { ResultPage } from "./run-result.js";

export interface ReportPrivacy {
  readonly secretValues: string[];
  readonly sensitiveOrigins?: readonly string[];
  readonly sensitivePaths?: readonly string[];
}

export function safeText(
  value: string,
  privacy: ReportPrivacy,
  limit: number,
): string {
  let text = value;
  for (const secret of [...privacy.secretValues]
    .filter((item) => item.length > 0)
    .sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const marker = "…[truncated]";
  return (
    points.slice(0, Math.max(0, limit - Array.from(marker).length)).join("") +
    marker
  );
}

export function safeUrl(
  raw: string,
  privacy: ReportPrivacy,
): { url: string; sensitive: boolean } {
  try {
    const url = new URL(raw);
    const sensitive =
      (privacy.sensitiveOrigins ?? []).includes(url.origin) ||
      (privacy.sensitivePaths ?? []).some((prefix) =>
        url.pathname.startsWith(prefix),
      );
    if (sensitive) return { url: url.origin, sensitive: true };
    return {
      url: safeText(`${url.origin}${url.pathname}`, privacy, 512),
      sensitive: false,
    };
  } catch {
    return { url: "[unavailable]", sensitive: false };
  }
}

export function safeSource(
  source: FlowSource,
  repoRoot: string,
  privacy: ReportPrivacy,
): FlowSource {
  const relative = path.relative(repoRoot, source.file);
  const file =
    relative.startsWith("..") || path.isAbsolute(relative)
      ? path.basename(source.file)
      : relative;
  return {
    file: safeText(file || path.basename(source.file), privacy, 512),
    line: source.line,
    col: source.col,
  };
}

function sameVersion(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.revision === b.revision &&
    a.route === b.route
  );
}

/** Read metadata only while it still describes the accepted page version. */
export async function reportPage(
  page: BrowserPage,
  observationId: string,
  privacy: ReportPrivacy,
  expectedVersion?: PageVersion,
): Promise<ResultPage> {
  try {
    const before = await pageVersion(page);
    if (expectedVersion && !sameVersion(before, expectedVersion))
      return { status: "unavailable", reason: "stale_page" };
    const raw = page.url;
    const title = page.title ? await page.title() : "";
    const after = await pageVersion(page);
    if (!sameVersion(before, after))
      return { status: "unavailable", reason: "stale_page" };
    const projected = safeUrl(raw, privacy);
    if (projected.sensitive)
      return { status: "omitted", reason: "sensitive_page" };
    return {
      status: "available",
      observationId,
      url: projected.url,
      title: safeText(title, privacy, 120),
    };
  } catch {
    return { status: "unavailable", reason: "page_unavailable" };
  }
}
