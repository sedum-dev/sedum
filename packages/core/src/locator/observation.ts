import type { BrowserPage } from "../browser-driver.js";
import { quietPage } from "../page-bridge.js";
import { isRunWideProviderError, type ProviderCall } from "../provider.js";
import type { LocatorResult } from "../locator.js";

/** A fresh resolution threw; carries the calls already made for the report. */
export class LocateRetryError extends Error {
  constructor(readonly priorCalls: readonly ProviderCall[]) {
    super("The target could not be resolved.");
  }
}

interface ReobserveOptions {
  readonly staleRetry: boolean;
  readonly signal?: AbortSignal;
}

function shouldRetryStale(result: LocatorResult, enabled: boolean): boolean {
  if (!enabled || result.kind === "resolved") return false;
  return result.reason === "stale";
}

async function retryStaleResolution(
  page: BrowserPage,
  resolved: LocatorResult,
  locate: () => Promise<LocatorResult>,
  enabled: boolean,
): Promise<LocatorResult> {
  if (!shouldRetryStale(resolved, enabled)) return resolved;

  const priorCalls = resolved.calls;
  const settled = await quietPage(page, 1_000, 4_000).catch(() => ({
    quiet: false,
  }));
  if (!settled.quiet) return resolved;

  try {
    const retried = await locate();
    return { ...retried, calls: [...priorCalls, ...retried.calls] };
  } catch (error) {
    if (isRunWideProviderError(error)) throw error;
    throw new LocateRetryError(priorCalls);
  }
}

function hasNoCandidates(result: LocatorResult): boolean {
  if (result.kind === "resolved") return false;
  return result.reason === "no_candidates";
}

function mayRetry(deadline: number, signal?: AbortSignal): boolean {
  if (performance.now() >= deadline) return false;
  return signal?.aborted !== true;
}

async function observeAfterDelay(
  page: BrowserPage,
  locate: () => Promise<LocatorResult>,
): Promise<LocatorResult | undefined> {
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  const settled = await quietPage(page, 80, 1_000).catch(() => ({
    quiet: false,
  }));
  if (!settled.quiet) return undefined;
  try {
    return await locate();
  } catch (error) {
    if (isRunWideProviderError(error)) throw error;
    // A redirect can invalidate the read-only execution context.
    return undefined;
  }
}

interface EmptyRetryContext {
  readonly locate: () => Promise<LocatorResult>;
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

async function pollEmptyObservation(
  page: BrowserPage,
  resolved: LocatorResult,
  context: EmptyRetryContext,
): Promise<LocatorResult> {
  if (!mayRetry(context.deadline, context.signal)) return resolved;
  const fresh = await observeAfterDelay(page, context.locate);
  if (!fresh) return pollEmptyObservation(page, resolved, context);
  const accumulated = { ...fresh, calls: [...resolved.calls, ...fresh.calls] };
  if (!hasNoCandidates(accumulated)) return accumulated;
  return pollEmptyObservation(page, accumulated, context);
}

async function retryEmptyObservation(
  page: BrowserPage,
  initial: LocatorResult,
  locate: () => Promise<LocatorResult>,
  signal?: AbortSignal,
): Promise<LocatorResult> {
  if (!hasNoCandidates(initial)) return initial;
  return pollEmptyObservation(page, initial, {
    locate,
    deadline: performance.now() + 8_000,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Re-observe a resolution that failed only because the page moved under it.
 * Nothing has been acted on yet, so a fresh read is safe for any operation.
 */
export async function reobserveLocator(
  page: BrowserPage,
  first: LocatorResult,
  locate: () => Promise<LocatorResult>,
  options: ReobserveOptions,
): Promise<LocatorResult> {
  // A resolver response can arrive during an unrelated DOM revision. One fresh
  // read after a longer quiet period reuses neither a target nor a prior action.
  const fresh = await retryStaleResolution(
    page,
    first,
    locate,
    options.staleRetry,
  );
  // Navigation can briefly leave a quiet, empty document before the real page
  // commits. Retry only the empty candidate set within the original deadline.
  return retryEmptyObservation(page, fresh, locate, options.signal);
}

function unresolvedReason(reason: string, op: string): string {
  if (reason === "none")
    return "no element on the page matches it; check the wording against the page";
  if (reason === "no_candidates") {
    const action = op === "type" ? "type into" : op;
    return `the page had nothing to ${action}`;
  }
  return "several elements match it; name the one you mean more precisely";
}

function visionFailure(
  vision: Extract<
    LocatorResult,
    { kind: "unresolved" }
  >["diagnostic"]["vision"],
): string | undefined {
  if (!vision?.failure) return undefined;
  const status = vision.httpStatus ? `, HTTP ${vision.httpStatus}` : "";
  return `vision ${vision.failure}${status}`;
}

function visionFallbackNote(
  resolved: Extract<LocatorResult, { kind: "unresolved" }>,
): string | undefined {
  const vision = resolved.diagnostic.vision;
  if (vision?.outcome === "abstained")
    return "the vision model did not find it either";
  if (vision || resolved.reason === "no_candidates") return undefined;
  return "vision fallback could not run (it needs 2 to 40 fully visible, unobscured controls on screen)";
}

/** Why a step's target was not found, in words a test author can act on. */
export function unresolvedLocatorWhy(
  resolved: Extract<LocatorResult, { kind: "unresolved" }>,
  op: string,
  visionEnabled: boolean,
): string {
  const why = unresolvedReason(resolved.reason, op);
  const failure = visionFailure(resolved.diagnostic.vision);
  if (failure) return `${why} (${failure})`;
  if (!visionEnabled) return why;
  const note = visionFallbackNote(resolved);
  return note ? `${why}; ${note}` : why;
}
