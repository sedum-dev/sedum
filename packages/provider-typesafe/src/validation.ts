import { ProviderError } from "@sedum-dev/core";
import type {
  ProviderCall,
  ProviderRate,
  ProviderTokenUsage,
} from "@sedum-dev/core";
import { MODEL } from "./request.js";

const RATE: ProviderRate = {
  inputUsdPerMillion: 0.042,
  outputUsdPerMillion: 0,
  source: "https://typesafe.ai/blog/introducing-system-one-models-and-jev",
  checkedAt: "2026-09-21",
};
const SUM_TOLERANCE = 0.02;
const ARGMAX_TOLERANCE = 1e-6;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError(
      "invalid-response",
      "The provider returned an invalid response.",
    );
  return value as Record<string, unknown>;
}

function probability(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new ProviderError(
      "invalid-response",
      "The provider returned an invalid probability.",
    );
  return value;
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ProviderError(
      "invalid-response",
      "The provider returned invalid token usage.",
    );
  return value;
}

export function validateChoice(
  response: unknown,
  optionIds: readonly string[],
) {
  const answer = record(response);
  if (answer.type !== "choice" || typeof answer.choice !== "string")
    throw new ProviderError(
      "invalid-response",
      "The provider returned an invalid Choice answer.",
    );
  const values = record(answer.probabilities);
  const keys = Object.keys(values);
  const expected = new Set(optionIds);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key)) ||
    !Object.hasOwn(values, answer.choice)
  )
    throw new ProviderError(
      "invalid-response",
      "The provider Choice keys do not match the offered options.",
    );

  const probabilities: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  let sum = 0;
  let maximum = 0;
  for (const key of keys) {
    const value = probability(values[key]);
    probabilities[key] = value;
    sum += value;
    maximum = Math.max(maximum, value);
  }
  if (
    Math.abs(sum - 1) >= SUM_TOLERANCE ||
    maximum - probabilities[answer.choice]! > ARGMAX_TOLERANCE
  )
    throw new ProviderError(
      "invalid-response",
      "The provider Choice distribution is incoherent.",
    );
  const confidence =
    answer.confidence === undefined ? null : probability(answer.confidence);
  return { choice: answer.choice, probabilities, confidence };
}

export function validateNoul(response: unknown): number {
  const answer = record(response);
  if (answer.type !== "noul")
    throw new ProviderError(
      "invalid-response",
      "The provider returned an invalid Noul answer.",
    );
  return probability(answer.noul);
}

/** How a logical call reached its reply, as recorded by the adapter. */
export interface CallMeta {
  /** HTTP requests sent, including rate-limited ones. */
  readonly attempts: number;
  /** Requests that could have been billed; a 429 is not. */
  readonly billableAttempts?: number;
  readonly rateLimited?: boolean;
  readonly rateLimitWaitMs?: number;
  readonly queueWaitMs?: number;
}

export function validateCall(
  response: unknown,
  metaOrAttempts: CallMeta | number,
  requestedModel = MODEL,
  estimateJevCost = true,
): ProviderCall {
  const meta: CallMeta =
    typeof metaOrAttempts === "number"
      ? { attempts: metaOrAttempts }
      : metaOrAttempts;
  const attempts = meta.attempts;
  const billable = meta.billableAttempts ?? attempts;
  const reply = record(response);
  if (typeof reply.model !== "string" || reply.model.length === 0)
    throw new ProviderError(
      "invalid-response",
      "The provider omitted its model version.",
    );
  const usage = record(reply.usage);
  const tokens: ProviderTokenUsage = {
    inputTokens: tokenCount(usage.input_tokens),
    outputTokens: tokenCount(usage.output_tokens),
  };
  const rate = estimateJevCost && /^jev(?:-|$)/.test(reply.model) ? RATE : null;
  const cost =
    rate === null
      ? null
      : (tokens.inputTokens * rate.inputUsdPerMillion +
          tokens.outputTokens * rate.outputUsdPerMillion) /
        1_000_000;
  return {
    requestedModel,
    model: reply.model,
    attempts,
    usage: tokens,
    rate,
    successfulResponseCostUsd: cost,
    totalCostUsd: billable === 1 ? cost : null,
    ...(meta.rateLimited ? { rateLimited: true } : {}),
    ...(meta.rateLimitWaitMs
      ? { rateLimitWaitMs: Math.round(meta.rateLimitWaitMs) }
      : {}),
    ...(meta.queueWaitMs ? { queueWaitMs: Math.round(meta.queueWaitMs) } : {}),
  };
}

export function answersOf(response: unknown): Record<string, unknown> {
  return record(record(response).answers);
}
