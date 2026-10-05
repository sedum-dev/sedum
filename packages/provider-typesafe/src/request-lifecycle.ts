import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  type SystemOneRequest,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import { ProviderError, type ProviderCallOptions } from "@sedum-dev/core";
import {
  GateWaitExceeded,
  ProviderGate,
  RATE_LIMIT_BUDGET_MS,
  backoffDelay,
  cooldownDelay,
  parseRetryAfter,
} from "./gate.js";
import type { CallMeta } from "./validation.js";

const MAX_ATTEMPTS = 3;

type AttemptOutcome =
  | { readonly ok: true; readonly response: unknown }
  | { readonly ok: false; readonly error: unknown };

interface RequestLifecycleOptions {
  readonly client: TypeSafeClient;
  readonly gate: ProviderGate;
  readonly deadlineMs: number;
  readonly attemptTimeoutMs: number;
  readonly backoffInitialMs: number;
  readonly random: () => number;
  readonly now: () => number;
}

interface AttemptBudget {
  readonly remainingMs: number;
  readonly rateLimitWaitMs?: number;
}

export interface AskedResponse {
  readonly response: unknown;
  readonly meta: CallMeta;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryable(error: unknown): boolean {
  return (
    (error instanceof APIError && error.status === 529) ||
    error instanceof APIConnectionError
  );
}

function apiError(error: APIError, attempts: number): ProviderError {
  if (error.status === 401 || error.status === 403)
    return new ProviderError(
      "authentication",
      "TypeSafe authentication failed.",
      attempts,
    );
  if (error.status === 402)
    return new ProviderError(
      "configuration",
      "The TypeSafe account has no available API credits.",
      attempts,
    );
  if (error.status >= 400 && error.status < 500)
    return new ProviderError(
      "invalid-input",
      "TypeSafe rejected the provider request.",
      attempts,
    );
  return new ProviderError(
    "connection",
    "TypeSafe could not complete the request.",
    attempts,
  );
}

function safeError(error: unknown, attempts: number): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APIError) return apiError(error, attempts);
  if (error instanceof APITimeoutError)
    return new ProviderError(
      "timeout",
      "TypeSafe request timed out.",
      attempts,
    );
  if (error instanceof APIUserAbortError)
    return new ProviderError(
      "timeout",
      "TypeSafe request was canceled.",
      attempts,
    );
  return new ProviderError(
    "connection",
    "TypeSafe connection failed.",
    attempts,
  );
}

function isRateLimit(error: unknown): error is APIError {
  return error instanceof APIError && error.status === 429;
}

class RequestLifecycle {
  private requests = 0;
  private failures = 0;
  private rateLimits = 0;
  private activeMs = 0;
  private queueWaitMs = 0;
  private rateLimitWaitMs = 0;
  private firstRateLimitAt: number | null = null;
  private afterRateLimit = false;

  constructor(
    private readonly dependencies: RequestLifecycleOptions,
    private readonly request: SystemOneRequest,
    private readonly options?: ProviderCallOptions,
  ) {}

  async run(): Promise<AskedResponse> {
    for (;;) {
      const budget = this.attemptBudget();
      const admitted = await this.admit(budget);
      this.recordWait(admitted.waitedMs);
      if (admitted.value.ok) return this.success(admitted.value.response);
      await this.prepareRetry(admitted.value.error);
    }
  }

  private canceled(): ProviderError {
    return new ProviderError(
      "timeout",
      "Provider call exceeded its deadline or was canceled.",
      this.requests,
    );
  }

  private rateLimitExceeded(): ProviderError {
    return new ProviderError(
      "rate-limited",
      "TypeSafe kept rate limiting requests for five minutes.",
      this.requests,
    );
  }

  private attemptBudget(): AttemptBudget {
    const remainingMs = this.remainingActiveMs();
    const rateLimitWaitMs = this.remainingRateLimitWaitMs();
    return rateLimitWaitMs === undefined
      ? { remainingMs }
      : { remainingMs, rateLimitWaitMs };
  }

  private remainingActiveMs(): number {
    if (this.options?.signal?.aborted) throw this.canceled();
    const remainingMs = this.dependencies.deadlineMs - this.activeMs;
    if (remainingMs <= 0) throw this.canceled();
    return remainingMs;
  }

  private remainingRateLimitWaitMs(): number | undefined {
    if (this.firstRateLimitAt === null) return undefined;
    const remaining =
      RATE_LIMIT_BUDGET_MS - (this.dependencies.now() - this.firstRateLimitAt);
    if (remaining <= 0) throw this.rateLimitExceeded();
    return remaining;
  }

  private async admit(budget: AttemptBudget) {
    try {
      return await this.dependencies.gate.run(
        () => this.execute(budget.remainingMs),
        {
          ...(this.options?.signal ? { signal: this.options.signal } : {}),
          ...(budget.rateLimitWaitMs === undefined
            ? {}
            : { maxWaitMs: budget.rateLimitWaitMs }),
        },
      );
    } catch (error) {
      if (error instanceof GateWaitExceeded) throw this.rateLimitExceeded();
      throw this.canceled();
    }
  }

  private async execute(remainingMs: number): Promise<AttemptOutcome> {
    this.requests++;
    const started = this.dependencies.now();
    try {
      const response = await this.dependencies.client.systemOne(this.request, {
        ...(this.options?.signal ? { signal: this.options.signal } : {}),
        timeout: Math.max(
          1,
          Math.floor(Math.min(this.dependencies.attemptTimeoutMs, remainingMs)),
        ),
        retry: { maxRetries: 0 },
      });
      return { ok: true, response: response as unknown };
    } catch (error) {
      this.beginCooldown(error);
      return { ok: false, error };
    } finally {
      this.activeMs += Math.max(0, this.dependencies.now() - started);
    }
  }

  private beginCooldown(error: unknown): void {
    if (!isRateLimit(error)) return;
    if (this.options?.signal?.aborted) return;
    this.rateLimits++;
    const now = this.dependencies.now();
    const delay = cooldownDelay(
      parseRetryAfter(error.headers, this.dependencies.now()),
      this.rateLimits,
      this.dependencies.backoffInitialMs,
      this.dependencies.random(),
    );
    this.dependencies.gate.cooldown(now + delay);
  }

  private recordWait(waitedMs: number): void {
    if (this.afterRateLimit) this.rateLimitWaitMs += waitedMs;
    else this.queueWaitMs += waitedMs;
  }

  private success(response: unknown): AskedResponse {
    this.dependencies.gate.succeeded();
    return {
      response,
      meta: {
        attempts: this.requests,
        billableAttempts: this.requests - this.rateLimits,
        rateLimited: this.rateLimits > 0,
        rateLimitWaitMs: this.rateLimitWaitMs,
        queueWaitMs: this.queueWaitMs,
      },
    };
  }

  private async prepareRetry(error: unknown): Promise<void> {
    this.ensureRetryAllowed(error);
    if (this.continueAfterRateLimit(error)) return;
    await this.prepareBillableRetry(error);
  }

  private ensureRetryAllowed(error: unknown): void {
    if (this.options?.signal?.aborted) throw this.canceled();
    if (this.options?.maxAttempts === 1) throw safeError(error, this.requests);
  }

  private continueAfterRateLimit(error: unknown): boolean {
    if (!isRateLimit(error)) return false;
    this.firstRateLimitAt ??= this.dependencies.now();
    this.afterRateLimit = true;
    return true;
  }

  private async prepareBillableRetry(error: unknown): Promise<void> {
    this.afterRateLimit = false;
    if (!retryable(error)) throw safeError(error, this.requests);
    this.recordFailure();
    await this.waitBeforeRetry();
  }

  private recordFailure(): void {
    this.failures++;
    if (this.failures >= MAX_ATTEMPTS)
      throw new ProviderError(
        "retry-exhausted",
        "TypeSafe did not succeed after three attempts.",
        this.requests,
      );
  }

  private async waitBeforeRetry(): Promise<void> {
    const delay = backoffDelay(
      this.failures,
      this.dependencies.backoffInitialMs,
      this.dependencies.random(),
    );
    if (delay >= this.dependencies.deadlineMs - this.activeMs)
      throw this.canceled();
    try {
      await sleep(delay, this.options?.signal ?? new AbortController().signal);
    } catch {
      throw this.canceled();
    }
    this.activeMs += delay;
  }
}

export function askProvider(
  dependencies: RequestLifecycleOptions,
  request: SystemOneRequest,
  options?: ProviderCallOptions,
): Promise<AskedResponse> {
  return new RequestLifecycle(dependencies, request, options).run();
}
