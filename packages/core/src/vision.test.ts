import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterVisionResolver, type VisionObservation } from "./vision.js";

const observation: VisionObservation = {
  instruction: "click Edit on the right",
  image: new Uint8Array([1, 2, 3]),
  candidates: [
    { id: "C1", name: "Edit", role: "button" },
    { id: "C2", name: "Edit", role: "button" },
  ],
};
function reply(value: unknown) {
  return new Response(
    JSON.stringify({
      model: "google/test",
      choices: [{ message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 123, completion_tokens: 17, cost: 0.002 },
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe("OpenRouter vision adapter", () => {
  it("sends a labeled image and strict schema, preserves actual usage", async () => {
    const fetch = vi.fn(async () =>
      reply({ kind: "candidate", id: "C2", reason: "" }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await new OpenRouterVisionResolver({
      apiKey: "test-key",
    }).choose(observation);
    expect(result.decision).toEqual({ kind: "candidate", id: "C2" });
    expect(result.call).toMatchObject({
      model: "google/test",
      usage: { inputTokens: 123, outputTokens: 17 },
      totalCostUsd: 0.002,
    });
    const request = (fetch.mock.calls as unknown[][])[0]![1] as RequestInit;
    const body = JSON.parse(request.body as string);
    expect(body.provider).toEqual({
      require_parameters: true,
      allow_fallbacks: false,
    });
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[1].content[1].image_url.url).toBe(
      "data:image/png;base64,AQID",
    );
    expect(body.messages[1].content[0].text).not.toContain("test-key");
  });
  it.each([
    { kind: "candidate", id: "C99", reason: "" },
    { kind: "candidate", id: "C1", reason: "ambiguous" },
    { kind: "abstain", id: "C2", reason: "ambiguous" },
    { kind: "abstain", id: "", reason: "" },
  ])("rejects invalid selection %j without retry", async (value) => {
    const fetch = vi.fn(async () => reply(value));
    vi.stubGlobal("fetch", fetch);
    await expect(
      new OpenRouterVisionResolver({ apiKey: "test-key" }).choose(observation),
    ).rejects.toMatchObject({
      code: "invalid-response",
      failure: "invalid_selection",
      failedCall: { totalCostUsd: 0.002 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts an explicit abstention", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({ kind: "abstain", id: "", reason: "ambiguous" }),
      ),
    );
    expect(
      (
        await new OpenRouterVisionResolver({ apiKey: "test-key" }).choose(
          observation,
        )
      ).decision,
    ).toEqual({ kind: "abstain", reason: "ambiguous" });
  });
  it("never echoes provider error bodies or retries HTTP failures", async () => {
    const fetch = vi.fn(
      async () => new Response("sensitive upstream body", { status: 429 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new OpenRouterVisionResolver({ apiKey: "test-key" }).choose(observation),
    ).rejects.toThrow("Vision request failed (HTTP 429)");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 429, code: "rate-limited" },
    { status: 401, code: "authentication" },
    { status: 503, code: "invalid-response" },
  ])(
    "classifies HTTP $status without retaining its body",
    async ({ status, code }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("private provider payload", { status })),
      );
      const error = await new OpenRouterVisionResolver({ apiKey: "test-key" })
        .choose(observation)
        .catch((error) => error);
      expect(error).toMatchObject({
        code,
        failure: "http_error",
        httpStatus: status,
        elapsedMs: expect.any(Number),
        failedCall: {
          requestedModel: "google/gemini-3.8-flash",
          totalCostUsd: null,
        },
      });
      expect(JSON.stringify(error)).not.toContain("private provider payload");
      expect(JSON.stringify(error)).not.toContain("test-key");
    },
  );

  it.each([
    { content: "not json", finish: "stop", failure: "invalid_json" },
    { content: null, finish: "stop", failure: "invalid_envelope" },
    { content: null, finish: "length", failure: "truncated_response" },
    {
      content: '{"kind":"candidate","id":"C1","reason":""}',
      finish: "length",
      failure: "truncated_response",
    },
  ])(
    "distinguishes $failure and retains billed usage",
    async ({ content, finish, failure }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                model: "google/test",
                choices: [{ finish_reason: finish, message: { content } }],
                usage: {
                  prompt_tokens: 300,
                  completion_tokens: 1024,
                  cost: 0.004,
                },
              }),
            ),
        ),
      );
      await expect(
        new OpenRouterVisionResolver({ apiKey: "test-key" }).choose(
          observation,
        ),
      ).rejects.toMatchObject({
        failure,
        httpStatus: 200,
        failedCall: {
          usage: { inputTokens: 300, outputTokens: 1024 },
          totalCostUsd: 0.004,
        },
      });
    },
  );

  it("distinguishes transport errors, deadline expiry and caller cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("private transport detail");
      }),
    );
    await expect(
      new OpenRouterVisionResolver({ apiKey: "test-key" }).choose(observation),
    ).rejects.toMatchObject({ failure: "connection", code: "connection" });
    const fetch = vi.fn(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new OpenRouterVisionResolver({ apiKey: "test-key", timeoutMs: 5 }).choose(
        observation,
      ),
    ).rejects.toMatchObject({ failure: "timeout", code: "timeout" });
    await expect(
      new OpenRouterVisionResolver({ apiKey: "test-key" }).choose(observation, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ failure: "canceled" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
