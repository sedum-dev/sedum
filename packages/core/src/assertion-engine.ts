import { BrowserDriverError, type BrowserPage } from "./browser-driver.js";
import {
  pageDigest,
  pageVersion,
  PageScriptError,
  quietPage,
} from "./page-bridge.js";
import {
  codePoints,
  DIGEST_LIMIT,
  type DigestResult,
  type PageVersion,
} from "./page-protocol.js";
import type { Judge, ProviderCall } from "./provider.js";

const DEFAULT_OBSERVATION_TIMEOUT_MS = 4_000;
const POST_JUDGE_VERSION_TIMEOUT_MS = 1_000;
const QUIET_MS = 80;
const EXCERPT_LIMIT = 1_500;
const TRUNCATION_MARKER = "…[truncated]";

export const DEFAULT_MIN_P = 0.75;
export const DEFAULT_BAND = 0.15;
export const DEFAULT_CONTRADICTION_CUTOFF = 0.5;

export type VerifyFlag = "low_confidence" | "contradiction";
export type AssertionEngineErrorCode =
  | "missing_digest"
  | "ambiguous_digest"
  | "incomplete_digest"
  | "oversize_digest"
  | "stale_observation"
  | "observation_timeout"
  | "browser_failure"
  | "canceled"
  | "provider_failure";

/** Public diagnostics contain only a stable code and a bounded message. */
export class AssertionEngineError extends Error {
  constructor(readonly code: AssertionEngineErrorCode) {
    super(`Assertion could not be judged: ${code}.`);
    this.name = "AssertionEngineError";
  }

  toJSON(): { code: AssertionEngineErrorCode; message: string } {
    return { code: this.code, message: this.message };
  }
}

export interface AssertionOptions {
  readonly signal?: AbortSignal;
  /** Maximum time for the settled page read, before the provider call. */
  readonly observationTimeoutMs?: number;
}

export interface VerifyOptions extends AssertionOptions {
  readonly minP?: number;
}

interface AssertionScores {
  readonly holds: number;
  readonly contradicted: number;
  readonly call: ProviderCall;
  readonly elapsedMs: number;
}

export type VerifyResult = AssertionScores & {
  readonly kind: "verify";
  readonly verdict: "passed" | "failed";
  readonly flags: readonly VerifyFlag[];
  readonly minP: number;
  readonly band: number;
  readonly contradictionCutoff: number;
  /** Present for flagged or failed checks; always drawn from the judged digest. */
  readonly judgedExcerpt?: string;
};

export type MeasureResult = AssertionScores & {
  readonly kind: "measure";
  readonly judgedExcerpt: string;
};

export interface VerifyPolicy {
  readonly minP?: number;
  readonly band?: number;
  readonly contradictionCutoff?: number;
}

export interface VerifyDecision {
  readonly verdict: "passed" | "failed";
  readonly flags: readonly VerifyFlag[];
  readonly minP: number;
  readonly band: number;
  readonly contradictionCutoff: number;
}

function probability(value: number, name: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new RangeError(`${name} must be a finite probability in [0, 1].`);
}

/** The mutually exclusive SED-13 table. No scores are rounded before comparison. */
export function evaluateVerifyScores(
  holds: number,
  contradicted: number,
  policy: VerifyPolicy = {},
): VerifyDecision {
  const minP = policy.minP ?? DEFAULT_MIN_P;
  const band = policy.band ?? DEFAULT_BAND;
  const contradictionCutoff =
    policy.contradictionCutoff ?? DEFAULT_CONTRADICTION_CUTOFF;
  probability(holds, "holds");
  probability(contradicted, "contradicted");
  probability(minP, "minP");
  probability(band, "band");
  probability(contradictionCutoff, "contradictionCutoff");

  if (holds < minP - band)
    return { verdict: "failed", flags: [], minP, band, contradictionCutoff };
  const flags: VerifyFlag[] = [];
  if (holds < minP) flags.push("low_confidence");
  if (contradicted >= contradictionCutoff) flags.push("contradiction");
  return { verdict: "passed", flags, minP, band, contradictionCutoff };
}

function validateInput(claim: string, options: AssertionOptions): number {
  if (typeof claim !== "string" || claim.trim().length === 0)
    throw new TypeError("Claim must be nonempty text.");
  const timeout =
    options.observationTimeoutMs ?? DEFAULT_OBSERVATION_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    throw new RangeError(
      "Observation timeout must be a positive finite duration.",
    );
  return timeout;
}

function sameVersion(left: PageVersion, right: PageVersion): boolean {
  return (
    left.document === right.document &&
    left.revision === right.revision &&
    left.route === right.route
  );
}

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

function canceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AssertionEngineError("canceled");
}

/** Bound read-only browser operations even when the driver cannot cancel an evaluation. */
function withinObservation<T>(
  operation: Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  canceled(signal);
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new AssertionEngineError("observation_timeout");
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(new AssertionEngineError("canceled"));
    const timer = setTimeout(
      () => finish(new AssertionEngineError("observation_timeout")),
      remaining,
    );
    function finish(error?: unknown, result?: T) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) reject(error);
      else resolve(result as T);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    operation.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}

function observationError(
  error: unknown,
  signal?: AbortSignal,
): AssertionEngineError {
  if (error instanceof AssertionEngineError) return error;
  if (signal?.aborted) return new AssertionEngineError("canceled");
  if (error instanceof PageScriptError && error.code === "missing")
    return new AssertionEngineError("missing_digest");
  return new AssertionEngineError("browser_failure");
}

function navigationRace(error: unknown): boolean {
  if (error instanceof BrowserDriverError && error.code !== "operation-failed")
    return false;
  const message = error instanceof Error ? error.message : "";
  return /execution context was destroyed|cannot find context with specified id|frame was detached|navigation in progress/i.test(
    message,
  );
}

function validateDigest(result: DigestResult): void {
  if (
    result.error === "digest_too_large" ||
    codePoints(result.text) > DIGEST_LIMIT
  )
    throw new AssertionEngineError("oversize_digest");
  if (result.error === "scope_ambiguous")
    throw new AssertionEngineError("ambiguous_digest");
  if (result.error === "resource_ceiling" || !result.complete || result.error)
    throw new AssertionEngineError("incomplete_digest");
}

async function settledDigest(
  page: BrowserPage,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DigestResult> {
  const deadline = performance.now() + timeoutMs;
  try {
    const settled = await withinObservation(
      page.settle({ state: "domcontentloaded", timeoutMs }),
      deadline,
      signal,
    );
    if (!settled.settled) throw new AssertionEngineError("observation_timeout");
    for (;;) {
      canceled(signal);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new AssertionEngineError("observation_timeout");
      try {
        const quiet = await withinObservation(
          quietPage(page, QUIET_MS, Math.max(1, remaining)),
          deadline,
          signal,
        );
        if (
          !quiet ||
          typeof quiet.quiet !== "boolean" ||
          !validVersion(quiet.version)
        )
          throw new AssertionEngineError("browser_failure");
        if (!quiet.quiet) continue;
        const digest = await withinObservation(
          pageDigest(page),
          deadline,
          signal,
        );
        validateDigest(digest);
        if (!digest.text.trim()) continue;
        const current = await withinObservation(
          pageVersion(page),
          deadline,
          signal,
        );
        if (
          sameVersion(quiet.version, digest.version) &&
          sameVersion(current, digest.version)
        )
          return digest;
      } catch (error) {
        if (navigationRace(error)) continue;
        throw error;
      }
    }
  } catch (error) {
    throw observationError(error, signal);
  }
}

function excerpt(text: string): string {
  if (codePoints(text) <= EXCERPT_LIMIT) return text;
  const available = EXCERPT_LIMIT - codePoints(TRUNCATION_MARKER);
  return Array.from(text).slice(0, available).join("") + TRUNCATION_MARKER;
}

async function judgePage(
  page: BrowserPage,
  judge: Judge,
  claim: string,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const digest = await settledDigest(page, timeoutMs, signal);
  canceled(signal);
  let decision;
  try {
    decision = await judge.holds(
      claim,
      { complete: true, text: digest.text },
      signal ? { signal } : {},
    );
    canceled(signal);
    probability(decision.holds, "holds");
    probability(decision.contradicted, "contradicted");
  } catch (error) {
    if (error instanceof AssertionEngineError) throw error;
    if (signal?.aborted) throw new AssertionEngineError("canceled");
    throw new AssertionEngineError("provider_failure");
  }
  let current: PageVersion;
  try {
    current = await withinObservation(
      pageVersion(page),
      performance.now() + POST_JUDGE_VERSION_TIMEOUT_MS,
      signal,
    );
  } catch (error) {
    throw observationError(error, signal);
  }
  if (!sameVersion(current, digest.version))
    throw new AssertionEngineError("stale_observation");
  return { decision, digest };
}

export async function verify(
  page: BrowserPage,
  judge: Judge,
  claim: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const started = performance.now();
  const timeoutMs = validateInput(claim, options);
  probability(options.minP ?? DEFAULT_MIN_P, "minP");
  canceled(options.signal);
  const { decision, digest } = await judgePage(
    page,
    judge,
    claim,
    timeoutMs,
    options.signal,
  );
  const policy = evaluateVerifyScores(
    decision.holds,
    decision.contradicted,
    options.minP === undefined ? {} : { minP: options.minP },
  );
  const needsExcerpt = policy.verdict === "failed" || policy.flags.length > 0;
  return {
    kind: "verify",
    ...policy,
    holds: decision.holds,
    contradicted: decision.contradicted,
    call: decision.call,
    elapsedMs: performance.now() - started,
    ...(needsExcerpt ? { judgedExcerpt: excerpt(digest.text) } : {}),
  };
}

export async function measure(
  page: BrowserPage,
  judge: Judge,
  claim: string,
  options: AssertionOptions = {},
): Promise<MeasureResult> {
  const started = performance.now();
  const timeoutMs = validateInput(claim, options);
  canceled(options.signal);
  const { decision, digest } = await judgePage(
    page,
    judge,
    claim,
    timeoutMs,
    options.signal,
  );
  return {
    kind: "measure",
    holds: decision.holds,
    contradicted: decision.contradicted,
    call: decision.call,
    elapsedMs: performance.now() - started,
    judgedExcerpt: excerpt(digest.text),
  };
}
