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

type Recovery = "stale" | "empty" | "none";

/** What a failed resolution needs: a fresh read, a later read, or nothing. */
function recoveryFor(result: LocatorResult, staleRetry: boolean): Recovery {
  if (result.kind === "resolved") return "none";
  if (result.reason === "no_candidates") return "empty";
  return staleRetry && result.reason === "stale" ? "stale" : "none";
}

function mayRetry(deadline: number, signal?: AbortSignal): boolean {
  if (performance.now() >= deadline) return false;
  return signal?.aborted !== true;
}

/** A fresh read, or undefined when only this read failed (not the run). */
async function tryLocate(
  locate: () => Promise<LocatorResult>,
): Promise<LocatorResult | undefined> {
  try {
    return await locate();
  } catch (error) {
    if (isRunWideProviderError(error)) throw error;
    return undefined;
  }
}

async function relocateAfterRender(
  page: BrowserPage,
  locate: () => Promise<LocatorResult>,
  priorCalls: readonly ProviderCall[],
): Promise<LocatorResult> {
  // A busy page (a ticker, a poll, a spinner) is never quiet for long, so wait
  // out the current render pass only; the page script still guards identity.
  await quietPage(page, 80, 1_000).catch(() => undefined);
  const fresh = await tryLocate(locate);
  if (!fresh) throw new LocateRetryError(priorCalls);
  return fresh;
}

async function relocateWhenFilled(
  page: BrowserPage,
  locate: () => Promise<LocatorResult>,
): Promise<LocatorResult | undefined> {
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  const settled = await quietPage(page, 80, 1_000).catch(() => ({
    quiet: false,
  }));
  // A redirect can invalidate the read-only execution context; poll again.
  return settled.quiet ? tryLocate(locate) : undefined;
}

async function readAgain(
  page: BrowserPage,
  recovery: Exclude<Recovery, "none">,
  locate: () => Promise<LocatorResult>,
  current: LocatorResult,
): Promise<LocatorResult> {
  const fresh =
    recovery === "stale"
      ? await relocateAfterRender(page, locate, current.calls)
      : await relocateWhenFilled(page, locate);
  return fresh
    ? { ...fresh, calls: [...current.calls, ...fresh.calls] }
    : current;
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
  // A page that renders in passes can be empty on one read and replace the
  // chosen node on the next, in either order; read again until it holds still.
  // Each stale read costs a model call, so a target that never holds still
  // gets a few fresh reads, not the whole deadline.
  const deadline = performance.now() + 8_000;
  let staleReads = 0;
  let current = first;
  for (;;) {
    const recovery = recoveryFor(current, options.staleRetry && staleReads < 4);
    if (recovery === "none" || !mayRetry(deadline, options.signal))
      return current;
    staleReads += Number(recovery === "stale");
    current = await readAgain(page, recovery, locate, current);
  }
}

function unresolvedReason(reason: string, op: string): string {
  if (reason === "none")
    return "no element on the page matches it; check the wording against the page";
  if (reason === "no_candidates") {
    const action = op === "type" ? "type into" : op;
    return `the page had nothing to ${action}`;
  }
  if (reason === "stale")
    return "the page kept replacing it while it was located; wait for the page to settle first";
  if (reason === "provider_error")
    return "the model call that picks the target failed; run the test again";
  return "several elements match it; name the one you mean more precisely";
}

function visionFailure(
  vision: Extract<
    LocatorResult,
    { kind: "unresolved" }
  >["diagnostic"]["vision"],
): string | undefined {
  return vision?.failure ? `vision ${vision.failure}` : undefined;
}

function visionFallbackNote(
  resolved: Extract<LocatorResult, { kind: "unresolved" }>,
): string | undefined {
  const vision = resolved.diagnostic.vision;
  if (vision?.outcome === "abstained")
    return "the vision model did not find it either";
  if (vision || ["no_candidates", "stale"].includes(resolved.reason))
    return undefined;
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
