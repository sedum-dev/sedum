import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  type Fetch,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { ClassificationBatchError, ProviderError } from "@sedum-dev/core";
import type {
  ClassificationProvider,
  ModelClassification,
  Judge,
  JudgeDecision,
  JudgePageDigest,
  ProviderCallOptions,
  Resolver,
  ResolverCandidates,
  ResolverDecision,
} from "@sedum-dev/core";
import { MODEL_CHOICES } from "@sedum-dev/core";
import {
  buildClassificationRequests,
  buildJudgeRequest,
  buildResolverRequest,
  MODEL,
} from "./request.js";
import {
  answersOf,
  validateCall,
  validateChoice,
  validateNoul,
  type CallMeta,
} from "./validation.js";
import {
  GateWaitExceeded,
  ProviderGate,
  RATE_LIMIT_BUDGET_MS,
  backoffDelay,
  cooldownDelay,
  parseRetryAfter,
} from "./gate.js";

const BASE_URL = "https://api.typesafe.ai";
const MAX_ATTEMPTS = 3;
const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = 500;

export interface TypeSafeAdapterOptions {
  readonly apiKey?: string;
  /** Explicit transport injection for recorded-reply tests. Production uses Node fetch pooling. */
  readonly fetch?: Fetch;
  readonly deadlineMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly backoffInitialMs?: number;
  /**
   * Admission shared by every lane of a run: a concurrency cap plus one 429
   * cooldown. Adapters built without one get a private gate.
   */
  readonly gate?: ProviderGate;
  /** Injected for deterministic jitter in tests. */
  readonly random?: () => number;
  /** Injected clock for deterministic wait accounting in tests. */
  readonly now?: () => number;
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new ProviderError(
      "configuration",
      label + " must be a finite positive millisecond duration.",
    );
  return value;
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

/** Retryable failures other than 429, which waits on the shared cooldown instead. */
function retryable(error: unknown): boolean {
  return (
    (error instanceof APIError && error.status === 529) ||
    error instanceof APIConnectionError
  );
}

function safeError(error: unknown, attempts: number): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403)
      return new ProviderError(
        "authentication",
        "TypeSafe authentication failed.",
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

function responseError(
  error: unknown,
  attempts: number,
  call: ReturnType<typeof validateCall>,
): ProviderError {
  return error instanceof ProviderError
    ? new ProviderError(error.code, error.message, attempts, call)
    : new ProviderError(
        "invalid-response",
        "The provider returned an invalid response.",
        attempts,
        call,
      );
}

/** One reusable, Node-side adapter supplies both task-specific core interfaces. */
export class TypeSafeAdapter
  implements Resolver, Judge, ClassificationProvider
{
  private readonly client: TypeSafeClient;
  private readonly deadlineMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly backoffInitialMs: number;
  private readonly gate: ProviderGate;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: TypeSafeAdapterOptions = {}) {
    const key = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    if (typeof key !== "string" || key.trim().length === 0)
      throw new ProviderError(
        "configuration",
        "Set TYPESAFE_API_KEY to use the TypeSafe provider.",
      );
    this.deadlineMs = positiveDuration(
      options.deadlineMs ?? DEFAULT_DEADLINE_MS,
      "Provider deadline",
    );
    this.attemptTimeoutMs = positiveDuration(
      options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      "Attempt timeout",
    );
    this.backoffInitialMs = positiveDuration(
      options.backoffInitialMs ?? DEFAULT_BACKOFF_MS,
      "Retry backoff",
    );
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.gate = options.gate ?? new ProviderGate({ now: this.now });
    this.client = new TypeSafeClient({
      apiKey: key.trim(),
      baseURL: BASE_URL,
      defaultModel: MODEL,
      logLevel: "off",
      timeout: this.attemptTimeoutMs,
      retry: { maxRetries: 0 },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /**
   * Send one logical call. The call's deadline and `MAX_ATTEMPTS` cover only
   * active request time and non-429 failures, measured from admission. Time
   * waiting for a slot or a shared cooldown is bounded by the caller's signal
   * (the run deadline or an interrupt) and, after the first 429, by
   * `RATE_LIMIT_BUDGET_MS`.
   */
  private async ask(
    request: SystemOneRequest,
    options?: ProviderCallOptions,
  ): Promise<{ response: unknown; meta: CallMeta }> {
    const signal = options?.signal;
    let requests = 0;
    let failures = 0;
    let rateLimits = 0;
    let activeMs = 0;
    let queueWaitMs = 0;
    let rateLimitWaitMs = 0;
    let firstRateLimitAt: number | null = null;
    let afterRateLimit = false;
    const canceled = () =>
      new ProviderError(
        "timeout",
        "Provider call exceeded its deadline or was canceled.",
        requests,
      );
    for (;;) {
      if (signal?.aborted) throw canceled();
      const remaining = this.deadlineMs - activeMs;
      if (remaining <= 0) throw canceled();
      const budgetLeft =
        firstRateLimitAt === null
          ? undefined
          : RATE_LIMIT_BUDGET_MS - (this.now() - firstRateLimitAt);
      if (budgetLeft !== undefined && budgetLeft <= 0)
        throw new ProviderError(
          "rate-limited",
          "TypeSafe kept rate limiting requests for five minutes.",
          requests,
        );
      let admitted: Awaited<
        ReturnType<
          typeof this.gate.run<
            | { readonly ok: true; readonly response: unknown }
            | { readonly ok: false; readonly error: unknown }
          >
        >
      >;
      try {
        admitted = await this.gate.run(
          async () => {
            requests++;
            const started = this.now();
            try {
              const response = await this.client.systemOne(request, {
                ...(signal ? { signal } : {}),
                timeout: Math.max(
                  1,
                  Math.floor(Math.min(this.attemptTimeoutMs, remaining)),
                ),
                retry: { maxRetries: 0 },
              });
              return { ok: true as const, response: response as unknown };
            } catch (error) {
              // Start the shared cooldown before this slot is released, so no
              // queued request slips out between the 429 and the pause.
              if (
                error instanceof APIError &&
                error.status === 429 &&
                !signal?.aborted
              ) {
                rateLimits++;
                this.gate.cooldown(
                  this.now() +
                    cooldownDelay(
                      parseRetryAfter(error.headers, this.now()),
                      rateLimits,
                      this.backoffInitialMs,
                      this.random(),
                    ),
                );
              }
              return { ok: false as const, error };
            } finally {
              activeMs += Math.max(0, this.now() - started);
            }
          },
          {
            ...(signal ? { signal } : {}),
            ...(budgetLeft === undefined ? {} : { maxWaitMs: budgetLeft }),
          },
        );
      } catch (error) {
        if (error instanceof GateWaitExceeded)
          throw new ProviderError(
            "rate-limited",
            "TypeSafe kept rate limiting requests for five minutes.",
            requests,
          );
        throw canceled();
      }
      if (afterRateLimit) rateLimitWaitMs += admitted.waitedMs;
      else queueWaitMs += admitted.waitedMs;
      const outcome = admitted.value;
      if (outcome.ok) {
        this.gate.succeeded();
        return {
          response: outcome.response,
          meta: {
            attempts: requests,
            billableAttempts: requests - rateLimits,
            rateLimited: rateLimits > 0,
            rateLimitWaitMs,
            queueWaitMs,
          },
        };
      }
      const error = outcome.error;
      if (signal?.aborted) throw canceled();
      if (error instanceof APIError && error.status === 429) {
        firstRateLimitAt ??= this.now();
        afterRateLimit = true;
        continue;
      }
      afterRateLimit = false;
      if (!retryable(error)) throw safeError(error, requests);
      failures++;
      if (failures >= MAX_ATTEMPTS)
        throw new ProviderError(
          "retry-exhausted",
          "TypeSafe did not succeed after three attempts.",
          requests,
        );
      const delay = backoffDelay(
        failures,
        this.backoffInitialMs,
        this.random(),
      );
      if (delay >= this.deadlineMs - activeMs) throw canceled();
      try {
        await sleep(delay, signal ?? new AbortController().signal);
      } catch {
        throw canceled();
      }
      activeMs += delay;
    }
  }

  async choose(
    sentence: string,
    candidates: ResolverCandidates,
    options?: ProviderCallOptions,
  ): Promise<ResolverDecision> {
    const built = buildResolverRequest(sentence, candidates);
    const { response, meta } = await this.ask(built.request, options);
    const call = validateCall(response, meta);
    const attempts = call.attempts;
    let answer: ReturnType<typeof validateChoice>;
    try {
      answer = validateChoice(answersOf(response).target, built.optionIds);
    } catch (error) {
      throw responseError(error, attempts, call);
    }
    return {
      selection:
        answer.choice === "none"
          ? { kind: "none" }
          : { kind: "candidate", id: answer.choice },
      probabilities: answer.probabilities,
      confidence: answer.confidence,
      call,
    };
  }

  async holds(
    claim: string,
    pageDigest: JudgePageDigest,
    options?: ProviderCallOptions,
  ): Promise<JudgeDecision> {
    const request = buildJudgeRequest(claim, pageDigest);
    const { response, meta } = await this.ask(request, options);
    const call = validateCall(response, meta);
    const attempts = call.attempts;
    let holds: number;
    let contradicted: number;
    try {
      const answers = answersOf(response);
      holds = validateNoul(answers.holds);
      contradicted = validateNoul(answers.contradicted);
    } catch (error) {
      throw responseError(error, attempts, call);
    }
    return { holds, contradicted, call };
  }

  async classifyBatch(
    sentences: readonly string[],
    options?: ProviderCallOptions,
  ): Promise<{
    readonly answers: readonly ModelClassification[];
    readonly calls: readonly ReturnType<typeof validateCall>[];
  }> {
    const chunks = buildClassificationRequests(sentences);
    const answers: ModelClassification[] = Array(sentences.length);
    const calls: ReturnType<typeof validateCall>[] = [];
    for (const chunk of chunks) {
      let attempts = 0;
      let receiptRecorded = false;
      try {
        const asked = await this.ask(chunk.request, options);
        attempts = asked.meta.attempts;
        const call = validateCall(asked.response, asked.meta);
        calls.push(call);
        receiptRecorded = true;
        const replyAnswers = answersOf(asked.response);
        const keys = Object.keys(replyAnswers);
        if (
          keys.length !== chunk.keys.length ||
          keys.some((key) => !chunk.keys.includes(key))
        )
          throw new ProviderError(
            "invalid-response",
            "Classification answer keys do not match the questions.",
          );
        const validated = chunk.keys.map((key) =>
          validateChoice(replyAnswers[key], MODEL_CHOICES),
        );
        validated.forEach((answer, offset) => {
          answers[chunk.indexes[offset]!] = {
            op: answer.choice as ModelClassification["op"],
            probabilities:
              answer.probabilities as ModelClassification["probabilities"],
            model: call.model,
            requestedModel: call.requestedModel,
          };
        });
      } catch (error) {
        throw new ClassificationBatchError(
          calls,
          receiptRecorded
            ? 0
            : attempts || (error instanceof ProviderError ? error.attempts : 0),
          error instanceof ProviderError ? error.code : null,
        );
      }
    }
    return { answers, calls };
  }
}

export type TypeSafeResolver = Resolver;
export type TypeSafeJudge = Judge;
export { probeTypeSafeApiKey } from "./doctor.js";
export {
  ProviderGate,
  DEFAULT_PROVIDER_CONCURRENCY,
  MAX_PROVIDER_CONCURRENCY,
  RATE_LIMIT_BUDGET_MS,
} from "./gate.js";
export type { AuthProbeResult } from "./doctor.js";
