import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_CHOICES, ProviderError, ProviderGate } from "@sedum-dev/core";
import { ClefAdapter, probeClefApiKey } from "./index.js";

afterEach(() => vi.useRealTimers());

const accountId = "0123456789abcdef0123456789abcdef";
const distribution = (choice: string, ids: readonly string[]) => ({
  type: "choice",
  choice,
  confidence: 0.95,
  probabilities: Object.fromEntries(
    ids.map((id) => [id, id === choice ? 1 : 0]),
  ),
});
const envelope = (answers: Record<string, unknown>, model = "clef") =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        model,
        answers,
        usage: { input_tokens: 100, output_tokens: 3 },
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

describe("ClefAdapter", () => {
  it("uses the fixed account/model route, redirect:error, envelope, and Clef receipt", async () => {
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`,
        );
        expect(init?.redirect).toBe("error");
        expect(JSON.parse(String(init?.body)).model).toBe("clef-flash");
        return envelope(
          { target: distribution("save", ["save", "none"]) },
          "clef-flash",
        );
      },
    );
    const result = await new ClefAdapter({
      accountId,
      apiKey: "secret",
      model: "clef-flash",
      fetch,
    }).choose("Select Save", {
      complete: true,
      options: [
        {
          kind: "candidate",
          candidate: {
            id: "save",
            tag: "button",
            role: "button",
            name: "Save",
            peers: [],
            editable: false,
            disabled: false,
          },
        },
        { kind: "none", id: "none" },
      ],
    });
    expect(result.selection).toEqual({ kind: "candidate", id: "save" });
    expect(result.call).toMatchObject({
      provider: "clef",
      requestedModel: "clef-flash",
      rate: { inputUsdPerMillion: 0.09 },
    });
  });

  it("rejects configuration and malformed envelopes without exposing the key", async () => {
    expect(
      () => new ClefAdapter({ accountId: "bad", apiKey: "secret" }),
    ).toThrow(ProviderError);
    const adapter = new ClefAdapter({
      accountId,
      apiKey: "very-secret",
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ message: "very-secret" }],
          }),
        ),
    });
    await expect(
      adapter.holds("Saved", { complete: true, text: "Saved" }),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      adapter.holds("Saved", { complete: true, text: "Saved" }),
    ).rejects.not.toThrow("very-secret");
  });

  it("splits classification without exceeding the hosted 64-question ceiling", async () => {
    const sizes: number[] = [];
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const keys = Object.keys(body.questions);
        sizes.push(keys.length);
        return envelope(
          Object.fromEntries(
            keys.map((key) => [key, distribution("click", MODEL_CHOICES)]),
          ),
        );
      },
    );
    const result = await new ClefAdapter({
      accountId,
      apiKey: "key",
      fetch,
    }).classifyBatch(Array.from({ length: 65 }, (_, i) => `click item ${i}`));
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(65);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
    expect(sizes.length).toBeGreaterThan(1);
    expect(result.answers).toHaveLength(65);
  });

  it("rejects singleton goal target choices before transmission", async () => {
    const fetch = vi.fn();
    await expect(
      new ClefAdapter({ accountId, apiKey: "key", fetch }).chooseGoal({
        goal: "Search",
        page: "Search",
        recentActions: [],
        targets: { CLICK: { one: "Search" } },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts 255 goal options, rejects 256 and oversized goal bodies before transmission", async () => {
    const targets = Object.fromEntries(
      Array.from({ length: 255 }, (_, i) => [`c${i}`, `Target ${i}`]),
    );
    const fetch = vi.fn(async () =>
      envelope({
        operation: distribution("CLICK", ["CLICK", "DONE", "BLOCKED"]),
        click_target: distribution("c254", Object.keys(targets)),
      }),
    );
    const adapter = new ClefAdapter({ accountId, apiKey: "key", fetch });
    const state = {
      goal: "Click last",
      page: "Page",
      recentActions: [],
      targets: { CLICK: targets },
    };
    expect((await adapter.chooseGoal(state)).target?.choice).toBe("c254");
    await expect(
      adapter.chooseGoal({
        ...state,
        targets: { CLICK: { ...targets, extra: "Extra" } },
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      adapter.chooseGoal({ ...state, page: "x".repeat(65536) }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores an unused speculative head but rejects a malformed selected head", async () => {
    const fetch = vi.fn(async () =>
      envelope({
        operation: distribution("DONE", ["CLICK", "DONE", "BLOCKED"]),
        click_target: null,
      }),
    );
    const adapter = new ClefAdapter({ accountId, apiKey: "key", fetch });
    const state = {
      goal: "Done",
      page: "Done",
      recentActions: [],
      targets: { CLICK: { a: "A", b: "B" } },
    };
    expect(await adapter.chooseGoal(state)).not.toHaveProperty("target");
    fetch.mockImplementation(async () =>
      envelope({
        operation: distribution("CLICK", ["CLICK", "DONE", "BLOCKED"]),
        click_target: null,
      }),
    );
    await expect(adapter.chooseGoal(state)).rejects.toMatchObject({
      code: "invalid-response",
      failedCall: { provider: "clef" },
    });
  });

  it("preserves abstention and rejects missing item and unexpected relevance/classification answers", async () => {
    const fetch = vi.fn(async () =>
      envelope({ target: distribution("none", ["save", "none"]) }),
    );
    const adapter = new ClefAdapter({ accountId, apiKey: "key", fetch });
    expect(
      (
        await adapter.choose("Missing", {
          complete: true,
          options: [
            {
              kind: "candidate",
              candidate: {
                id: "save",
                tag: "button",
                role: "button",
                name: "Save",
                peers: [],
                editable: false,
                disabled: false,
              },
            },
            { kind: "none", id: "none" },
          ],
        })
      ).selection,
    ).toEqual({ kind: "none" });
    fetch.mockImplementation(async () => envelope({}));
    await expect(
      adapter.verifyItems("One", [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ]),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(adapter.classifyBatch(["Click Save"])).rejects.toMatchObject({
      code: "invalid-response",
      failedAttempts: 0,
      calls: [expect.objectContaining({ provider: "clef" })],
    });
    await expect(
      adapter.scoreRelevance("diff", [
        { file: "x", source: "test", modules: [] },
      ]),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("supports judge, item verification, relevance, and goal heads", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const keys = Object.keys(body.questions);
        const answers = Object.fromEntries(
          keys.map((key) => {
            if (body.questions[key].type === "noul")
              return [
                key,
                {
                  type: "noul",
                  noul: key === "contradicted" || key === "item0" ? 0.07 : 0.91,
                },
              ];
            const ids = Object.keys(body.questions[key].criteria);
            const selected = key === "operation" ? "CLICK" : ids[0]!;
            return [key, distribution(selected, ids)];
          }),
        );
        return envelope(answers);
      },
    );
    const adapter = new ClefAdapter({ accountId, apiKey: "key", fetch });
    await expect(
      adapter.holds("Saved", { complete: true, text: "Saved" }),
    ).resolves.toMatchObject({ holds: 0.91, contradicted: 0.07 });
    await expect(
      adapter.verifyItems("Select first", [
        { id: "a", text: "First" },
        { id: "b", text: "Second" },
      ]),
    ).resolves.toMatchObject({ scores: { a: 0.07, b: 0.91 } });
    await expect(
      adapter.scoreRelevance("diff", [
        { file: "a.test.ts", source: "test", modules: [] },
      ]),
    ).resolves.toMatchObject({ probabilities: [0.91] });
    const goal = await adapter.chooseGoal({
      goal: "Search",
      page: "Search",
      recentActions: [],
      targets: { CLICK: { search: "Search", __sedum_no_match: "No match" } },
    });
    expect(goal).toMatchObject({
      operation: { choice: "CLICK" },
      target: { choice: "search" },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

const page = { complete: true, text: "Saved" };
const judged = () =>
  envelope({
    holds: { type: "noul", noul: 0.91 },
    contradicted: { type: "noul", noul: 0.07 },
  });

describe("Clef transport boundaries", () => {
  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [402, "configuration"],
    [400, "invalid-input"],
    [404, "invalid-input"],
    [302, "connection"],
  ])("does not retry HTTP %i", async (status, code) => {
    const fetch = vi.fn(
      async () => new Response("upstream secret", { status: Number(status) }),
    );
    const error = await new ClefAdapter({ accountId, apiKey: "private", fetch })
      .holds("Saved", page)
      .catch((e) => e);
    expect(error).toMatchObject({
      code,
      attempts: 1,
      failedCall: { provider: "clef", totalCostUsd: null },
    });
    expect(JSON.stringify(error)).not.toMatch(/private|upstream secret/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries transient errors but preserves unknown total cost", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network secret"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockImplementation(judged);
    const result = await new ClefAdapter({
      accountId,
      apiKey: "key",
      fetch,
      backoffInitialMs: 1,
      random: () => 0,
    }).holds("Saved", page);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.call).toMatchObject({
      attempts: 3,
      totalCostUsd: null,
      successfulResponseCostUsd: 0.000024,
    });
  });

  it("bounds repeated failures to three attempts and honors maxAttempts=1", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 503 }));
    const adapter = new ClefAdapter({
      accountId,
      apiKey: "key",
      fetch,
      backoffInitialMs: 1,
    });
    await expect(adapter.holds("Saved", page)).rejects.toMatchObject({
      code: "retry-exhausted",
      attempts: 3,
    });
    fetch.mockClear();
    await expect(
      adapter.holds("Saved", page, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "connection", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["bad-json", "envelope", "usage", "answer"])(
    "does not retry malformed successful %s",
    async (kind) => {
      const fetch = vi.fn(async () => {
        if (kind === "bad-json") return new Response("{");
        const data = await judged().json();
        if (kind === "envelope") data.success = false;
        if (kind === "usage") data.result.usage.input_tokens = -1;
        if (kind === "answer") data.result.answers.holds.noul = 1.01;
        return Response.json(data);
      });
      await expect(
        new ClefAdapter({ accountId, apiKey: "key", fetch }).holds(
          "Saved",
          page,
        ),
      ).rejects.toMatchObject({
        code: "invalid-response",
        attempts: 1,
        failedCall: { provider: "clef" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps timeout and concurrency admission active until the response body completes", async () => {
    vi.useFakeTimers();
    const gate = new ProviderGate({ concurrency: 1 });
    const fetch = vi.fn(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                "abort",
                () => controller.error(new Error("aborted")),
                { once: true },
              );
            },
          }),
        ),
    );
    const adapter = new ClefAdapter({
      accountId,
      apiKey: "key",
      fetch,
      gate,
      attemptTimeoutMs: 20,
    });
    const failure = expect(
      adapter.holds("Saved", page, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: "timeout", attempts: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(gate.inFlight).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    await failure;
    expect(gate.inFlight).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels queued requests without transmitting them", async () => {
    const gate = new ProviderGate({ concurrency: 1 });
    let release!: () => void;
    const holding = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const fetch = vi.fn(async () => judged());
    const controller = new AbortController();
    const result = new ClefAdapter({
      accountId,
      apiKey: "key",
      gate,
      fetch,
    }).holds("Saved", page, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: "timeout",
      attempts: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    release();
    await holding;
  });

  it("waits for shared 429 cooldown and does not assume the failed call was free", async () => {
    vi.useFakeTimers();
    const gate = new ProviderGate({ concurrency: 1 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "1" } }),
      )
      .mockImplementation(judged);
    const result = new ClefAdapter({
      accountId,
      apiKey: "key",
      gate,
      fetch,
      random: () => 0,
    }).holds("Saved", page);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect((await result).call).toMatchObject({
      attempts: 2,
      rateLimited: true,
      rateLimitWaitMs: 1000,
      totalCostUsd: null,
    });
    gate.close();
  });

  it("bounds sustained rate limiting and preserves one-attempt goal requests", async () => {
    vi.useFakeTimers();
    const gate = new ProviderGate();
    const fetch = vi.fn(
      async () =>
        new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    );
    const adapter = new ClefAdapter({
      accountId,
      apiKey: "key",
      gate,
      fetch,
      random: () => 0,
    });
    const limited = expect(adapter.holds("Saved", page)).rejects.toMatchObject({
      code: "rate-limited",
    });
    await vi.advanceTimersByTimeAsync(300_001);
    await limited;
    gate.close();
    const goalGate = new ProviderGate();
    fetch.mockClear();
    await expect(
      new ClefAdapter({
        accountId,
        apiKey: "key",
        gate: goalGate,
        fetch,
      }).chooseGoal({
        goal: "Done",
        page: "Done",
        recentActions: [],
        targets: {},
      }),
    ).rejects.toMatchObject({ code: "rate-limited", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    goalGate.close();
  });

  it("retains earlier classification receipts on a later failed chunk", async () => {
    const fetch = vi
      .fn(async (_url, init) => {
        const keys = Object.keys(JSON.parse(String(init?.body)).questions);
        return envelope(
          Object.fromEntries(
            keys.map((key) => [key, distribution("remember", MODEL_CHOICES)]),
          ),
        );
      })
      .mockImplementationOnce(async (_url, init) => {
        const keys = Object.keys(JSON.parse(String(init?.body)).questions);
        return envelope(
          Object.fromEntries(
            keys.map((key) => [key, distribution("remember", MODEL_CHOICES)]),
          ),
        );
      })
      .mockImplementationOnce(async () => new Response("", { status: 403 }));
    const error = await new ClefAdapter({ accountId, apiKey: "key", fetch })
      .classifyBatch(Array(100).fill("capture value as {{item}}") as string[])
      .catch((e) => e);
    expect(error).toMatchObject({ code: "authentication", failedAttempts: 1 });
    expect(error.calls).toHaveLength(1);
    expect(error.calls[0].provider).toBe("clef");
  });

  it.each([
    [200, "accepted"],
    [401, "rejected"],
    [500, "unreachable"],
  ])(
    "doctor validates a single inference response (HTTP %i)",
    async (status, expected) => {
      const fetch = vi.fn(async () =>
        Number(status) === 200
          ? judged()
          : new Response("", { status: Number(status) }),
      );
      expect(
        await probeClefApiKey("key", { accountId, model: "clef", fetch }),
      ).toBe(expected);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("doctor rejects invalid configuration and malformed 200 responses", async () => {
    const fetch = vi.fn(async () => Response.json({ success: false }));
    expect(
      await probeClefApiKey("key", {
        accountId: "../other",
        model: "clef",
        fetch,
      }),
    ).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await probeClefApiKey("key", { accountId, model: "clef", fetch }),
    ).toBe("unavailable");
  });
});
