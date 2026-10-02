import PQueue from "p-queue";

/** One cooldown window never exceeds this, matching the SDK's `maxRetryAfterMs`. */
export const MAX_COOLDOWN_MS = 60_000;
/** Cumulative wait a call may spend after its first 429 before it gives up. */
export const RATE_LIMIT_BUDGET_MS = 300_000;
/** Fraction of each backoff delay randomly subtracted, as in the SDK policy. */
export const BACKOFF_JITTER = 0.25;
export const DEFAULT_PROVIDER_CONCURRENCY = 4;
export const MAX_PROVIDER_CONCURRENCY = 32;

/**
 * Server-requested delay in milliseconds, following the TypeSafe SDK's
 * `RetryPolicy`: `retry-after-ms`, then `Retry-After` as seconds or an HTTP
 * date. Returns null when absent or malformed so the caller falls back to
 * backoff.
 */
export function parseRetryAfter(
  headers: Headers | undefined,
  now: number,
): number | null {
  const ms = headers?.get("retry-after-ms")?.trim();
  if (ms && /^\d+(?:\.\d+)?$/u.test(ms)) return Math.ceil(Number(ms));
  const value = headers?.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Math.ceil(Number(value) * 1000);
  // An HTTP date always names a weekday or month; this rejects bare numbers
  // such as "-3" that Date.parse would otherwise accept.
  if (!/[a-z]/iu.test(value)) return null;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Exponential backoff with subtractive jitter, capped at one window. */
export function backoffDelay(
  failures: number,
  initialMs: number,
  random: number,
): number {
  const base = Math.min(
    MAX_COOLDOWN_MS,
    initialMs * 2 ** Math.max(0, failures - 1),
  );
  return Math.max(1, Math.round(base * (1 - BACKOFF_JITTER * random)));
}

/** The delay for one 429: the server's request when given, else backoff. */
export function cooldownDelay(
  retryAfterMs: number | null,
  rateLimitCount: number,
  initialMs: number,
  random: number,
): number {
  const requested =
    retryAfterMs ?? backoffDelay(rateLimitCount, initialMs, random);
  // Jitter only lengthens a server-requested delay, so lanes do not all return at once.
  const jittered =
    retryAfterMs === null
      ? requested
      : requested + Math.round(requested * BACKOFF_JITTER * random);
  return Math.min(MAX_COOLDOWN_MS, Math.max(1, jittered));
}

/**
 * Additive-increase ramp after a cooldown: one request first, one more per
 * success, back to one on any new 429.
 */
export function nextConcurrency(
  current: number,
  cap: number,
  event: "success" | "rate-limited",
): number {
  return event === "rate-limited" ? 1 : Math.min(cap, current + 1);
}

export class GateWaitExceeded extends Error {
  constructor() {
    super("Provider gate wait exceeded its budget");
    this.name = "GateWaitExceeded";
  }
}

export class GateAborted extends Error {
  constructor() {
    super("Provider gate wait was canceled");
    this.name = "GateAborted";
  }
}

export interface ProviderGateOptions {
  readonly concurrency?: number;
  readonly now?: () => number;
}

/**
 * Admission control shared by every lane of a run: a concurrency cap on
 * in-flight provider requests plus one cooldown that pauses all of them after
 * a 429. Backed by p-queue.
 */
export class ProviderGate {
  readonly cap: number;
  private readonly queue: PQueue;
  private readonly now: () => number;
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ProviderGateOptions = {}) {
    const cap = options.concurrency ?? DEFAULT_PROVIDER_CONCURRENCY;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_PROVIDER_CONCURRENCY)
      throw new RangeError(
        `Provider concurrency must be an integer from 1 to ${MAX_PROVIDER_CONCURRENCY}.`,
      );
    this.cap = cap;
    this.now = options.now ?? Date.now;
    this.queue = new PQueue({ concurrency: cap });
  }

  /** Current admission limit; below the cap while ramping after a cooldown. */
  get concurrency(): number {
    return this.queue.concurrency;
  }

  get coolingDown(): boolean {
    return this.queue.isPaused;
  }

  get inFlight(): number {
    return this.queue.pending;
  }

  /**
   * Run `task` once a slot is free and no cooldown is active. Waiting ends
   * with `GateAborted` when `signal` aborts, or `GateWaitExceeded` after
   * `maxWaitMs`; neither consumes a slot.
   */
  async run<T>(
    task: () => Promise<T>,
    options: {
      readonly signal?: AbortSignal;
      readonly maxWaitMs?: number;
    } = {},
  ): Promise<{ readonly value: T; readonly waitedMs: number }> {
    const started = this.now();
    const controller = new AbortController();
    let reason: "abort" | "budget" | null = null;
    const onAbort = () => {
      reason ??= "abort";
      controller.abort();
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const budget =
      options.maxWaitMs === undefined || !Number.isFinite(options.maxWaitMs)
        ? undefined
        : setTimeout(
            () => {
              reason ??= "budget";
              controller.abort();
            },
            Math.max(0, options.maxWaitMs),
          );
    let admittedAt: number | null = null;
    try {
      const value = await this.queue.add(
        async () => {
          admittedAt = this.now();
          if (budget) clearTimeout(budget);
          return task();
        },
        { signal: controller.signal },
      );
      return { value, waitedMs: (admittedAt ?? this.now()) - started };
    } catch (error) {
      if (admittedAt === null && reason === "budget")
        throw new GateWaitExceeded();
      if (admittedAt === null && reason === "abort") throw new GateAborted();
      throw error;
    } finally {
      if (budget) clearTimeout(budget);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Pause admission for every lane until at least `until`; later requests extend it. */
  cooldown(until: number): void {
    this.queue.concurrency = nextConcurrency(
      this.queue.concurrency,
      this.cap,
      "rate-limited",
    );
    if (until <= this.cooldownUntil && this.timer) return;
    this.cooldownUntil = Math.max(this.cooldownUntil, until);
    this.queue.pause();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.queue.start();
      },
      Math.max(0, this.cooldownUntil - this.now()),
    );
  }

  /**
   * Release the pending cooldown timer when the run ends, so an interrupted
   * or timed-out run does not keep the process alive until the window closes.
   */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One successful response widens admission by one, up to the cap. */
  succeeded(): void {
    this.queue.concurrency = nextConcurrency(
      this.queue.concurrency,
      this.cap,
      "success",
    );
  }
}
