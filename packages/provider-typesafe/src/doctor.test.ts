import { describe, expect, it } from "vitest";
import type { Fetch } from "@typesafe-ai/sdk";
import { probeTypeSafeApiKey } from "./doctor.js";

describe("TypeSafe doctor authentication probe", () => {
  it("uses one small SDK request and accepts a successful response", async () => {
    const calls: string[] = [];
    const fetch: Fetch = async (input, init) => {
      calls.push(String(init?.body));
      expect(String(input)).toBe("https://api.typesafe.ai/v1/systemone");
      return new Response(
        JSON.stringify({
          answers: {
            ready: {
              type: "choice",
              choice: "ready",
              probabilities: { ready: 1, other: 0 },
            },
          },
          model: "jev-1.13.0",
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    expect(await probeTypeSafeApiKey("SECRET-KEY", { fetch })).toBe("accepted");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("SECRET-KEY");
  });

  it.each([401, 403])(
    "classifies HTTP %i as rejected without exposing the body",
    async (status) => {
      const fetch: Fetch = async () =>
        new Response("SECRET-KEY was rejected", { status });
      expect(await probeTypeSafeApiKey("SECRET-KEY", { fetch })).toBe(
        "rejected",
      );
    },
  );

  it("classifies network failure and does not retry", async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls++;
      throw new Error("offline SECRET-KEY");
    };
    expect(await probeTypeSafeApiKey("SECRET-KEY", { fetch })).toBe(
      "unreachable",
    );
    expect(calls).toBe(1);
  });

  it("bounds an authenticated request by its timeout", async () => {
    const fetch: Fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    expect(
      await probeTypeSafeApiKey("SECRET-KEY", { fetch, timeoutMs: 20 }),
    ).toBe("unreachable");
  });
});
