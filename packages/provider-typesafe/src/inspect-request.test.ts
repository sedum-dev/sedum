import { describe, expect, it } from "vitest";
import { ProviderError } from "@sedum-dev/core";
import type { Fetch } from "@typesafe-ai/sdk";
import { TypeSafeAdapter } from "./index.js";
import { INSPECT_KEYS, buildInspectRequest } from "./inspect-request.js";
import { validateScore } from "./validation.js";

const page = { path: "/orders", title: "Orders", text: "Something went wrong" };

const reply = {
  answers: {
    error_message: { type: "noul", noul: 0.98 },
    stuck_loading: { type: "noul", noul: 0.04 },
    empty_content: { type: "noul", noul: 0.1 },
    broken_value: { type: "noul", noul: 0.2 },
    severity: {
      type: "score",
      score: 2.97,
      confidence: 0.96,
      legend: {},
      probabilities: { "0": 0, "1": 0.01, "2": 0.01, "3": 0.98 },
    },
  },
  model: "jev-1.13.0",
  usage: { input_tokens: 1000, output_tokens: 86 },
};

function adapter(body: unknown, seen: string[] = []) {
  const fetch: Fetch = async (_input, init) => {
    seen.push(String(init?.body));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return new TypeSafeAdapter({ apiKey: "key", fetch });
}

describe("bug-detector inspection request", () => {
  it("asks four Nouls and a four-level severity Score about one state", () => {
    const request = buildInspectRequest(page, "jev-latest");
    expect(request.state).toEqual({
      path: "/orders",
      title: "Orders",
      page: "Something went wrong",
    });
    expect(Object.keys(request.questions)).toEqual([...INSPECT_KEYS]);
    const severity = request.questions.severity;
    expect(severity?.type).toBe("score");
    expect(severity?.type === "score" && severity.criteria).toHaveLength(4);
    for (const key of INSPECT_KEYS.slice(0, 4))
      expect(request.questions[key]).toMatchObject({ type: "noul" });
  });

  it("rejects page text over its limit", () => {
    expect(() =>
      buildInspectRequest({ ...page, text: "x".repeat(6001) }, "jev-latest"),
    ).toThrow(ProviderError);
  });

  it("parses the answers and costs the call", async () => {
    const seen: string[] = [];
    const result = await adapter(reply, seen).inspectPage(page);
    expect(result.probabilities).toEqual({
      error_message: 0.98,
      stuck_loading: 0.04,
      empty_content: 0.1,
      broken_value: 0.2,
    });
    expect(result.severity).toEqual({
      score: 2.97,
      confidence: 0.96,
      probabilities: [0, 0.01, 0.01, 0.98],
    });
    expect(result.call.usage.inputTokens).toBe(1000);
    expect(result.call.totalCostUsd).toBeCloseTo(0.000042, 9);
    expect(JSON.parse(seen[0]!).model).toBe("jev-latest");
  });

  it("rejects a reply with missing or extra answers", async () => {
    const answers: Record<string, unknown> = { ...reply.answers };
    delete answers.severity;
    await expect(
      adapter({ ...reply, answers }).inspectPage(page),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("validateScore", () => {
  const score = (overrides: Record<string, unknown>) => ({
    ...reply.answers.severity,
    ...overrides,
  });

  it("returns the expected score with ordered probabilities", () => {
    expect(validateScore(score({}), 4).probabilities).toEqual([
      0, 0.01, 0.01, 0.98,
    ]);
  });

  it.each([
    ["a Noul", { type: "noul" }],
    ["a missing level", { probabilities: { "0": 0.5, "1": 0.5 } }],
    [
      "probabilities that do not sum to one",
      { probabilities: { "0": 0.5, "1": 0.5, "2": 0.5, "3": 0.5 } },
    ],
    ["a score beyond the top level", { score: 4.5 }],
    ["a missing confidence", { confidence: undefined }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => validateScore(score(overrides), 4)).toThrow(ProviderError);
  });
});
