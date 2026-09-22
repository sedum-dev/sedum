import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  type Fetch,
  type SystemOneRequest,
} from "@typesafe-ai/sdk";
import { ProviderError } from "@sedum-dev/core";
import type {
  Judge,
  JudgeDecision,
  JudgePageDigest,
  ProviderCallOptions,
  Resolver,
  ResolverCandidates,
  ResolverDecision,
} from "@sedum-dev/core";
import { buildJudgeRequest, buildResolverRequest, MODEL } from "./request.js";
import {
  answersOf,
  validateCall,
  validateChoice,
  validateNoul,
} from "./validation.js";

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

function retryable(error: unknown): boolean {
  return (
    (error instanceof APIError &&
      (error.status === 429 || error.status === 529)) ||
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

/** One reusable, Node-side adapter supplies both task-specific core interfaces. */
export class TypeSafeAdapter implements Resolver, Judge {
  private readonly client: TypeSafeClient;
  private readonly deadlineMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly backoffInitialMs: number;

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

  private async ask(request: SystemOneRequest, options?: ProviderCallOptions) {
    const controller = new AbortController();
    const callerAbort = () => controller.abort();
    if (options?.signal?.aborted) controller.abort();
    options?.signal?.addEventListener("abort", callerAbort, { once: true });
    const started = performance.now();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    let attempts = 0;
    try {
      for (;;) {
        if (controller.signal.aborted)
          throw new ProviderError(
            "timeout",
            "Provider call exceeded its deadline or was canceled.",
            attempts,
          );
        attempts++;
        const remaining = Math.max(
          1,
          Math.floor(this.deadlineMs - (performance.now() - started)),
        );
        try {
          const response = await this.client.systemOne(request, {
            signal: controller.signal,
            timeout: Math.min(this.attemptTimeoutMs, remaining),
            retry: { maxRetries: 0 },
          });
          if (controller.signal.aborted)
            throw new ProviderError(
              "timeout",
              "Provider call exceeded its deadline or was canceled.",
              attempts,
            );
          return { response: response as unknown, attempts };
        } catch (error) {
          if (controller.signal.aborted)
            throw new ProviderError(
              "timeout",
              "Provider call exceeded its deadline or was canceled.",
              attempts,
            );
          if (!retryable(error)) throw safeError(error, attempts);
          if (attempts >= MAX_ATTEMPTS)
            throw new ProviderError(
              "retry-exhausted",
              "TypeSafe did not succeed after three attempts.",
              attempts,
            );
          const delay = this.backoffInitialMs * 2 ** (attempts - 1);
          try {
            await sleep(delay, controller.signal);
          } catch {
            throw new ProviderError(
              "timeout",
              "Provider call exceeded its deadline or was canceled.",
              attempts,
            );
          }
        }
      }
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener("abort", callerAbort);
    }
  }

  async choose(
    sentence: string,
    candidates: ResolverCandidates,
    options?: ProviderCallOptions,
  ): Promise<ResolverDecision> {
    const built = buildResolverRequest(sentence, candidates);
    const { response, attempts } = await this.ask(built.request, options);
    const answer = validateChoice(answersOf(response).target, built.optionIds);
    const call = validateCall(response, attempts);
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
    const { response, attempts } = await this.ask(request, options);
    const answers = answersOf(response);
    const holds = validateNoul(answers.holds);
    const contradicted = validateNoul(answers.contradicted);
    const call = validateCall(response, attempts);
    return { holds, contradicted, call };
  }
}

export type TypeSafeResolver = Resolver;
export type TypeSafeJudge = Judge;
