import type { BrowserPage } from "./browser-driver.js";
import {
  PAGE_PROTOCOL,
  type AimResult,
  type CandidatePage,
  type DigestResult,
  type Operation,
  type PageVersion,
  type FillTarget,
  type ReadTargetResult,
} from "./page-protocol.js";
import { matchEntry, type CacheEntry, type MatchResult } from "./page-cache.js";

export class PageScriptError extends Error {
  constructor(
    readonly code: "missing" | "incompatible" | "invalid-result",
    message: string,
  ) {
    super(message);
    this.name = "PageScriptError";
  }
}
type Method =
  | "collect"
  | "digest"
  | "pageVersion"
  | "quiet"
  | "findBySignals"
  | "clickTarget"
  | "readTarget"
  | "clearRefs";
function validVersion(value: unknown): value is PageVersion {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PageVersion>;
  return (
    typeof item.document === "string" &&
    typeof item.route === "string" &&
    typeof item.revision === "number" &&
    Number.isInteger(item.revision)
  );
}
function validPage(value: CandidatePage): boolean {
  return (
    !!value &&
    value.protocol === PAGE_PROTOCOL &&
    validVersion(value.version) &&
    Number.isInteger(value.total) &&
    value.total >= 0 &&
    Number.isInteger(value.offset) &&
    value.offset >= 0 &&
    (value.next === null ||
      (Number.isInteger(value.next) && value.next > value.offset)) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.candidates) &&
    value.candidates.every(
      (item) =>
        typeof item.ref === "string" &&
        typeof item.name === "string" &&
        typeof item.tag === "string" &&
        typeof item.role === "string" &&
        Array.isArray(item.peers) &&
        (item.location === undefined || typeof item.location === "string") &&
        typeof item.disabled === "boolean" &&
        typeof item.editable === "boolean" &&
        !!item.signals &&
        typeof item.signals.path === "string",
    )
  );
}
async function call<T>(
  page: BrowserPage,
  method: Method,
  argument?: unknown,
): Promise<T> {
  const result = await page.evaluate<{
    installed: boolean;
    protocol?: number;
    value?: T;
  }>(`((argument) => {
    const bridge = window.__sedum;
    if (!bridge) return { installed: false };
    if (bridge.protocol !== ${PAGE_PROTOCOL}) return { installed: true, protocol: bridge.protocol };
    return Promise.resolve(bridge[${JSON.stringify(method)}](argument)).then(value => ({ installed: true, protocol: bridge.protocol, value: value ?? null }));
  })(${JSON.stringify(argument ?? null)})`);
  if (!result || !result.installed)
    throw new PageScriptError(
      "missing",
      "Sedum page script was not installed in this document.",
    );
  if (result.protocol !== PAGE_PROTOCOL)
    throw new PageScriptError(
      "incompatible",
      `Sedum page script protocol ${result.protocol} is incompatible with ${PAGE_PROTOCOL}.`,
    );
  if (!("value" in result))
    throw new PageScriptError(
      "invalid-result",
      `Page script ${method} returned no value.`,
    );
  return result.value as T;
}
export function collectCandidates(
  page: BrowserPage,
  operation: Operation,
  offset = 0,
  version?: PageVersion,
): Promise<CandidatePage> {
  return call<CandidatePage>(page, "collect", {
    operation,
    offset,
    ...(version ? { version } : {}),
  }).then((result) => {
    if (!validPage(result))
      throw new PageScriptError("invalid-result", "Invalid candidate page.");
    return result;
  });
}
export async function pageDigest(page: BrowserPage): Promise<DigestResult> {
  const result = await call<DigestResult>(page, "digest");
  if (
    !result ||
    result.protocol !== PAGE_PROTOCOL ||
    !validVersion(result.version) ||
    typeof result.text !== "string" ||
    typeof result.complete !== "boolean"
  )
    throw new PageScriptError("invalid-result", "Invalid page digest.");
  return result;
}
export async function pageVersion(page: BrowserPage): Promise<PageVersion> {
  const result = await call<PageVersion>(page, "pageVersion");
  if (!validVersion(result))
    throw new PageScriptError("invalid-result", "Invalid page version.");
  return result;
}
export function quietPage(
  page: BrowserPage,
  ms: number,
  timeoutMs: number,
): Promise<{ version: PageVersion; quiet: boolean }> {
  if (
    !Number.isFinite(ms) ||
    ms < 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  )
    throw new RangeError("Invalid quiet deadline");
  return call(page, "quiet", { ms, timeoutMs });
}
export async function liveCandidates(
  page: BrowserPage,
  operation: Operation,
): Promise<CandidatePage> {
  const result = await call<CandidatePage>(page, "findBySignals", {
    operation,
  });
  if (!validPage(result))
    throw new PageScriptError("invalid-result", "Invalid live candidate set.");
  return result;
}
export function clickTarget(
  page: BrowserPage,
  ref: string,
): Promise<AimResult> {
  return call(page, "clickTarget", ref);
}
export async function readTarget(
  page: BrowserPage,
  target: FillTarget,
): Promise<ReadTargetResult> {
  const result = await call<ReadTargetResult>(page, "readTarget", target);
  if (
    !result ||
    (result.status !== "stale" &&
      result.status !== "empty" &&
      result.status !== "too_long" &&
      !(result.status === "ok" && typeof result.text === "string"))
  )
    throw new PageScriptError("invalid-result", "Invalid target read.");
  return result;
}
export function clearPageRefs(page: BrowserPage): Promise<void> {
  return call(page, "clearRefs");
}

/** Match a store entry against every current candidate; the HMAC key never crosses the page bridge. */
export async function matchLiveEntry(
  page: BrowserPage,
  entry: CacheEntry | undefined,
  key: Uint8Array,
  operation: Operation,
  sentence: string,
  runtimeDependent = false,
): Promise<MatchResult> {
  const found = await liveCandidates(page, operation);
  const current = await pageVersion(page);
  if (
    !found.complete ||
    found.total !== found.candidates.length ||
    found.version.document !== current.document ||
    found.version.revision !== current.revision ||
    found.version.route !== current.route
  )
    return { hit: false, reason: "candidate_set_incomplete" };
  return matchEntry(
    entry,
    key,
    current.route,
    operation,
    sentence,
    found.candidates,
    true,
    runtimeDependent,
  );
}
