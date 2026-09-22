import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type ResolverCandidates } from "@sedum-dev/core";
import type { Fetch } from "@typesafe-ai/sdk";
import { TypeSafeAdapter } from "./index.js";
import { buildResolverRequest } from "./request.js";

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
const judgeReply = {
  answers: {
    holds: { type: "noul", noul: 0.9 },
    contradicted: { type: "noul", noul: 0.8 },
  },
  model: "jev-1.13.0",
  usage: { input_tokens: 200, output_tokens: 0 },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fake(
  responses: Array<
    Response | Error | ((signal: AbortSignal) => Promise<Response>)
  >,
) {
  const calls: Array<{ url: string; body: string; signal: AbortSignal }> = [];
  const fetch: Fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: String(init?.body),
      signal: init?.signal as AbortSignal,
    });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (typeof response === "function")
      return response(init?.signal as AbortSignal);
    if (!response) throw new Error("Unexpected network call");
    return response;
  };
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TypeSafeAdapter wire and lifecycle", () => {
  it("reuses one client for Choice and two Noul questions and pins SDK settings", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://wrong.example");
    vi.stubEnv("TYPESAFE_DEFAULT_MODEL", "wrong-model");
    vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const transport = fake([json(choiceReply), json(judgeReply)]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
    });
    const selected = await adapter.choose("Buy SECRET-SENTENCE", offered);
    const judged = await adapter.holds("Bought", {
      complete: true,
      text: "SECRET-PAGE says Bought",
    });
    expect(selected.selection).toEqual({ kind: "candidate", id: "a" });
    expect(selected.probabilities).toEqual({ a: 0.8, none: 0.2 });
    expect(selected.call).toMatchObject({
      attempts: 1,
      requestedModel: "jev-latest",
      model: "jev-1.13.0",
      usage: { inputTokens: 100 },
    });
    expect(judged).toMatchObject({
      holds: 0.9,
      contradicted: 0.8,
      call: { attempts: 1 },
    });
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls.map((call) => call.url)).toEqual(
      Array(2).fill("https://api.typesafe.ai/v1/systemone"),
    );
    expect(transport.calls[0]!.body).toBe(
      JSON.stringify(
        buildResolverRequest("Buy SECRET-SENTENCE", offered).request,
      ),
    );
    expect(JSON.parse(transport.calls[0]!.body).model).toBe("jev-latest");
    const judgeBody = JSON.parse(transport.calls[1]!.body);
    expect(judgeBody).toMatchObject({
      model: "jev-latest",
      state: { claim: "Bought", page: "SECRET-PAGE says Bought" },
    });
    expect(Object.keys(judgeBody.questions)).toEqual(["holds", "contradicted"]);
    expect(JSON.stringify([log.mock.calls, debug.mock.calls])).not.toMatch(
      /SECRET-SENTENCE|SECRET-PAGE|test-key/,
    );
  });

  it("returns none unchanged and prevents network calls on rejected input", async () => {
    const transport = fake([
      json({
        ...choiceReply,
        answers: {
          target: {
            type: "choice",
            choice: "none",
            probabilities: { a: 0.1, none: 0.9 },
          },
        },
      }),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
    });
    await expect(
      adapter.choose("Buy", { ...offered, complete: false }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(transport.calls).toHaveLength(0);
    await expect(adapter.choose("Buy", offered)).resolves.toMatchObject({
      selection: { kind: "none" },
    });
  });

  it("retries 429 and 529, then reports unknown total cost", async () => {
    const transport = fake([
      json({ error: "rate" }, 429),
      json({ error: "busy" }, 529),
      json(choiceReply),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
      backoffInitialMs: 1,
    });
    const result = await adapter.choose("Buy", offered);
    expect(transport.calls).toHaveLength(3);
    expect(result.call).toMatchObject({ attempts: 3, totalCostUsd: null });
    expect(result.call.successfulResponseCostUsd).toBeCloseTo(0.0000042);
  });

  it("retries a connection failure and exhausts after three calls", async () => {
    const transport = fake([
      new Error("secret connection detail"),
      new Error("second"),
      new Error("third"),
    ]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
      backoffInitialMs: 1,
    });
    await expect(adapter.choose("Buy", offered)).rejects.toMatchObject({
      code: "retry-exhausted",
      attempts: 3,
    });
    expect(transport.calls).toHaveLength(3);
  });

  it("retries an SDK attempt timeout and succeeds within the overall deadline", async () => {
    const timeout = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("attempt timed out")),
          { once: true },
        );
      });
    const transport = fake([timeout, json(choiceReply)]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: transport.fetch,
      attemptTimeoutMs: 10,
      deadlineMs: 1000,
      backoffInitialMs: 1,
    });
    const result = await adapter.choose("Buy", offered);
    expect(result.call.attempts).toBe(2);
    expect(transport.calls).toHaveLength(2);
  });

  it("does not retry authentication or a malformed successful reply", async () => {
    const denied = fake([json({ detail: "SECRET-ERROR-BODY" }, 401)]);
    await expect(
      new TypeSafeAdapter({ apiKey: "test-key", fetch: denied.fetch }).choose(
        "Buy",
        offered,
      ),
    ).rejects.toMatchObject({ code: "authentication", attempts: 1 });
    expect(denied.calls).toHaveLength(1);
    const bad = fake([
      json({
        ...choiceReply,
        answers: {
          target: {
            type: "choice",
            choice: "a",
            probabilities: { a: 2, none: -1 },
          },
        },
      }),
    ]);
    await expect(
      new TypeSafeAdapter({ apiKey: "test-key", fetch: bad.fetch }).choose(
        "Buy",
        offered,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(bad.calls).toHaveLength(1);
    const missingJudge = fake([
      json({ ...judgeReply, answers: { holds: { type: "noul", noul: 0.5 } } }),
    ]);
    await expect(
      new TypeSafeAdapter({
        apiKey: "test-key",
        fetch: missingJudge.fetch,
      }).holds("Bought", { complete: true, text: "Bought" }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(missingJudge.calls).toHaveLength(1);
  });

  it("enforces the overall deadline and caller cancellation", async () => {
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const deadline = fake([waitForAbort]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: deadline.fetch,
      deadlineMs: 10,
      attemptTimeoutMs: 100,
    });
    await expect(adapter.choose("Buy", offered)).rejects.toMatchObject({
      code: "timeout",
      attempts: 1,
    });
    const caller = new AbortController();
    const canceled = fake([waitForAbort]);
    const pending = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: canceled.fetch,
    }).choose("Buy", offered, { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
  });

  it("keeps public error serialization free of provider details", () => {
    const error = new ProviderError(
      "authentication",
      "TypeSafe authentication failed.",
      1,
    );
    expect(JSON.stringify(error)).toBe(
      '{"code":"authentication","message":"TypeSafe authentication failed.","attempts":1}',
    );
    expect(() => new TypeSafeAdapter({ apiKey: " " })).toThrow(
      /TYPESAFE_API_KEY/,
    );
  });
});
