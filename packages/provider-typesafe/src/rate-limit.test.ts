import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type ResolverCandidates } from "@sedum-dev/core";
import type { Fetch } from "@typesafe-ai/sdk";
import { ProviderGate, TypeSafeAdapter } from "./index.js";

const offered: ResolverCandidates = {
  complete: true,
  options: [
    {
      kind: "candidate",
      candidate: {
        id: "a",
        tag: "button",
        role: "button",
        name: "Buy",
        peers: [],
        editable: false,
        disabled: false,
      },
    },
    { kind: "none", id: "none" },
  ],
};
const choiceReply = {
  answers: {
    target: {
      type: "choice",
      choice: "a",
      probabilities: { a: 0.8, none: 0.2 },
    },
  },
  model: "jev-1.13.0",
  usage: { input_tokens: 100, output_tokens: 0 },
};

/**
 * A provider that rate limits a scripted number of requests. It records
 * violations: any request sent inside a window it announced, and the peak
 * number of requests in flight at once.
 */
function rateLimitedProvider(options: {
  readonly limitedRequests: number;
  readonly retryAfter: string;
  readonly latencyMs?: number;
}) {
  let sent = 0;
  let inFlight = 0;
  let peak = 0;
  let blockedUntil = 0;
  const violations: number[] = [];
  const latency = options.latencyMs ?? 50;
  const fetch: Fetch = async () => {
    sent++;
    const at = Date.now();
    if (at < blockedUntil) violations.push(at);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, latency));
    inFlight--;
    if (sent <= options.limitedRequests) {
      const seconds = Number(options.retryAfter);
      blockedUntil = Math.max(blockedUntil, Date.now() + seconds * 1000);
      return new Response(JSON.stringify({ error: "rate" }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": options.retryAfter,
        },
      });
    }
    return new Response(JSON.stringify(choiceReply), {
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch,
    get sent() {
      return sent;
    },
    get peak() {
      return peak;
    },
    violations,
  };
}

function adapter(gate: ProviderGate, fetch: Fetch): TypeSafeAdapter {
  return new TypeSafeAdapter({
    apiKey: "test-key",
    fetch,
    gate,
    backoffInitialMs: 1,
    random: () => 0,
  });
}

async function settle<T>(work: Promise<T>, stepMs = 250, limitMs = 900_000) {
  let done = false;
  let value: { ok: true; value: T } | { ok: false; error: unknown };
  work.then(
    (result) => {
      done = true;
      value = { ok: true, value: result };
    },
    (error: unknown) => {
      done = true;
      value = { ok: false, error };
    },
  );
  for (let elapsed = 0; !done && elapsed < limitMs; elapsed += stepMs)
    await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error("work did not settle");
  return value!;
}

describe("shared rate-limit backoff across parallel lanes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses every lane for Retry-After, caps in-flight calls, and completes", async () => {
    const provider = rateLimitedProvider({
      limitedRequests: 3,
      retryAfter: "2",
    });
    const gate = new ProviderGate({ concurrency: 2 });
    const shared = adapter(gate, provider.fetch);
    const lanes = Array.from({ length: 8 }, () =>
      shared.choose("Buy", offered),
    );
    const outcome = await settle(Promise.all(lanes));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(provider.violations).toEqual([]);
    expect(provider.peak).toBeLessThanOrEqual(2);
    const calls = outcome.value.map((decision) => decision.call);
    const limited = calls.filter((call) => call.rateLimited);
    expect(limited.length).toBeGreaterThan(0);
    for (const call of limited) {
      expect(call.rateLimitWaitMs).toBeGreaterThanOrEqual(2000);
      expect(call.totalCostUsd).not.toBeNull();
    }
    expect(calls.some((call) => (call.queueWaitMs ?? 0) > 0)).toBe(true);
    expect(provider.sent).toBe(8 + 3);
  });

  it("waits out a Retry-After longer than the 30 second active deadline", async () => {
    const provider = rateLimitedProvider({
      limitedRequests: 1,
      retryAfter: "45",
    });
    const outcome = await settle(
      adapter(new ProviderGate({ concurrency: 2 }), provider.fetch).choose(
        "Buy",
        offered,
      ),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect(outcome.value.call).toMatchObject({
        attempts: 2,
        rateLimited: true,
      });
  });

  it("survives four consecutive windows without spending MAX_ATTEMPTS", async () => {
    const provider = rateLimitedProvider({
      limitedRequests: 4,
      retryAfter: "10",
    });
    const outcome = await settle(
      adapter(new ProviderGate({ concurrency: 1 }), provider.fetch).choose(
        "Buy",
        offered,
      ),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.call.attempts).toBe(5);
      expect(outcome.value.call.rateLimitWaitMs).toBeGreaterThanOrEqual(40_000);
    }
    expect(provider.violations).toEqual([]);
  });

  it("fails with a typed rate-limited error once the budget is spent", async () => {
    const provider = rateLimitedProvider({
      limitedRequests: Number.MAX_SAFE_INTEGER,
      retryAfter: "60",
    });
    const started = Date.now();
    const outcome = await settle(
      adapter(new ProviderGate({ concurrency: 1 }), provider.fetch).choose(
        "Buy",
        offered,
      ),
      1000,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ProviderError);
    expect(outcome.error).toMatchObject({ code: "rate-limited" });
    expect(Date.now() - started).toBeLessThanOrEqual(300_000 + 61_000);
  });

  it("gives up waiting as a cancellation when the run aborts during a cooldown", async () => {
    const provider = rateLimitedProvider({
      limitedRequests: 1,
      retryAfter: "30",
    });
    const controller = new AbortController();
    const work = adapter(
      new ProviderGate({ concurrency: 1 }),
      provider.fetch,
    ).choose("Buy", offered, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5000);
    const outcome = await settle(work);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatchObject({ code: "timeout" });
    expect(provider.sent).toBe(1);
  });
});
