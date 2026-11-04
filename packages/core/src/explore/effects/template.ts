/**
 * Abstraction for the effects planner: many pages of one kind become one
 * route template, many records one name.
 */

/**
 * A path segment that names one record: a number, a UUID or another id
 * with dashes, a ULID, or a long token that mixes letters and digits.
 */
const RECORD_SEGMENT = [
  /^\d+$/u,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  /^[0-9A-HJKMNP-TV-Z]{26}$/iu,
  // Ids with dashes or underscores, as long as some part holds a digit.
  /^(?=[\w-]*\d)[0-9a-z]+(?:[-_][0-9a-z]+){2,}$/iu,
  /^(?=.*\d)[\w-]{16,}$/u,
];

export function isRecordSegment(segment: string): boolean {
  return RECORD_SEGMENT.some((pattern) => pattern.test(segment));
}

function foldPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (isRecordSegment(segment) ? ":id" : segment))
    .join("/");
}

/**
 * The route template of a URL: its path plus a hash route (`#/product/7`),
 * with the query dropped and record ids folded, e.g. `/product/:id`.
 */
export function pageTemplate(url: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return url;
  }
  const hash = /^#!?\//u.test(parsed.hash)
    ? parsed.hash.replace(/\?.*$/u, "")
    : "";
  return foldPath(parsed.pathname) + foldPath(hash);
}

/** A name with long ids and digits folded, so "Item 12" and "Item 13" agree. */
export function foldName(name: string): string {
  return name
    .replace(/\b[0-9A-Z]{20,}\b/gu, ":id")
    .replace(/\d+/gu, "#")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Whether a link stays on the start origin (scoped by origin, not domain). */
export function onStartOrigin(
  href: string | undefined,
  base: string,
  origin: string,
): boolean {
  if (!href) return true;
  try {
    const target = new URL(href, base);
    // A script link acts on this page.
    if (target.protocol === "javascript:") return true;
    if (!/^https?:$/u.test(target.protocol)) return false;
    return target.origin === origin;
  } catch {
    return false;
  }
}
