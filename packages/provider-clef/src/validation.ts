import { ProviderError } from "@sedum-dev/core";
import type { ProviderCall, ProviderRate } from "@sedum-dev/core";

const SUM_TOLERANCE = 0.02;
const ARGMAX_TOLERANCE = 1e-6;
const RATES: Readonly<Record<string, ProviderRate>> = {
  clef: {
    inputUsdPerMillion: 0.24,
    outputUsdPerMillion: 0,
    source: "https://developers.cloudflare.com/workers-ai/models/clef/",
    checkedAt: "2026-10-01",
  },
  "clef-flash": {
    inputUsdPerMillion: 0.09,
    outputUsdPerMillion: 0,
    source: "https://developers.cloudflare.com/workers-ai/models/clef-flash/",
    checkedAt: "2026-10-01",
  },
};
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError(
      "invalid-response",
      "Cloudflare returned an invalid response.",
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
      "Cloudflare returned an invalid probability.",
    );
  return value;
}
export function validateChoice(value: unknown, optionIds: readonly string[]) {
  const answer = record(value);
  if (answer.type !== "choice" || typeof answer.choice !== "string")
    throw new ProviderError(
      "invalid-response",
      "Cloudflare returned an invalid Choice answer.",
    );
  const raw = record(answer.probabilities);
  const keys = Object.keys(raw);
  const expected = new Set(optionIds);
  if (
    keys.length !== expected.size ||
    keys.some((key) => !expected.has(key)) ||
    !Object.hasOwn(raw, answer.choice)
  )
    throw new ProviderError(
      "invalid-response",
      "Cloudflare Choice keys do not match the offered options.",
    );
  const probabilities: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  let sum = 0;
  let maximum = 0;
  for (const key of keys) {
    const p = probability(raw[key]);
    probabilities[key] = p;
    sum += p;
    maximum = Math.max(maximum, p);
  }
  if (
    Math.abs(sum - 1) >= SUM_TOLERANCE ||
    maximum - probabilities[answer.choice]! > ARGMAX_TOLERANCE
  )
    throw new ProviderError(
      "invalid-response",
      "Cloudflare Choice distribution is incoherent.",
    );
  return {
    choice: answer.choice,
    probabilities,
    confidence: probability(answer.confidence),
  };
}
export function validateNoul(value: unknown): number {
  const answer = record(value);
  if (answer.type !== "noul")
    throw new ProviderError(
      "invalid-response",
      "Cloudflare returned an invalid Noul answer.",
    );
  return probability(answer.noul);
}
export interface CallMeta {
  attempts: number;
  billableAttempts?: number;
  rateLimited?: boolean;
  rateLimitWaitMs?: number;
  queueWaitMs?: number;
}
export function validateEnvelope(value: unknown): unknown {
  const envelope = record(value);
  if (
    envelope.success !== true ||
    !Object.hasOwn(envelope, "result") ||
    !Array.isArray(envelope.errors) ||
    envelope.errors.length !== 0 ||
    !Array.isArray(envelope.messages)
  )
    throw new ProviderError(
      "invalid-response",
      "Cloudflare returned an invalid API envelope.",
    );
  return envelope.result;
}
export function answersOf(response: unknown): Record<string, unknown> {
  return record(record(response).answers);
}
export function validateCall(
  response: unknown,
  meta: CallMeta,
  requestedModel: string,
): ProviderCall {
  const reply = record(response);
  if (
    typeof reply.model !== "string" ||
    !reply.model.trim() ||
    reply.model.length > 120
  )
    throw new ProviderError(
      "invalid-response",
      "Cloudflare omitted its model version.",
    );
  const usage = record(reply.usage);
  const token = (value: unknown) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new ProviderError(
        "invalid-response",
        "Cloudflare returned invalid token usage.",
      );
    return value;
  };
  const tokens = {
    inputTokens: token(usage.input_tokens),
    outputTokens: token(usage.output_tokens),
  };
  const rate = Object.hasOwn(RATES, reply.model) ? RATES[reply.model]! : null;
  const cost = rate
    ? (tokens.inputTokens * rate.inputUsdPerMillion) / 1_000_000
    : null;
  return {
    provider: "clef",
    requestedModel,
    model: reply.model,
    attempts: meta.attempts,
    usage: tokens,
    rate,
    successfulResponseCostUsd: cost,
    totalCostUsd: (meta.billableAttempts ?? meta.attempts) === 1 ? cost : null,
    ...(meta.rateLimited ? { rateLimited: true } : {}),
    ...(meta.rateLimitWaitMs
      ? { rateLimitWaitMs: Math.round(meta.rateLimitWaitMs) }
      : {}),
    ...(meta.queueWaitMs ? { queueWaitMs: Math.round(meta.queueWaitMs) } : {}),
  };
}
