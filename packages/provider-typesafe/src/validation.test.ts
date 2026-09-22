import { describe, expect, it } from "vitest";
import { validateCall, validateChoice, validateNoul } from "./validation.js";

describe("recorded provider replies", () => {
  it("keeps an exact distribution and accepts an argmax tie", () => {
    const answer = validateChoice(
      {
        type: "choice",
        choice: "b",
        probabilities: { a: 0.5, b: 0.5 },
        confidence: 0.2,
      },
      ["a", "b"],
    );
    expect(answer).toEqual({
      choice: "b",
      probabilities: { a: 0.5, b: 0.5 },
      confidence: 0.2,
    });
  });

  for (const [answer, label] of [
    [{ type: "choice", choice: "a", probabilities: { a: 1 } }, "missing key"],
    [
      {
        type: "choice",
        choice: "a",
        probabilities: { a: 0.5, b: 0.3, c: 0.2 },
      },
      "extra key",
    ],
    [
      { type: "choice", choice: "c", probabilities: { a: 0.5, b: 0.5 } },
      "unoffered choice",
    ],
    [
      { type: "choice", choice: "a", probabilities: { a: 0.4, b: 0.3 } },
      "bad sum",
    ],
    [
      { type: "choice", choice: "a", probabilities: { a: 0.2, b: 0.8 } },
      "not argmax",
    ],
    [{ type: "choice", choice: "a", probabilities: { a: NaN, b: 1 } }, "NaN"],
    [
      { type: "choice", choice: "a", probabilities: { a: Infinity, b: 0 } },
      "infinity",
    ],
    [
      { type: "choice", choice: "a", probabilities: { a: 1.1, b: -0.1 } },
      "out of range",
    ],
    [
      {
        type: "choice",
        choice: "a",
        probabilities: { a: 1, b: 0 },
        confidence: "1",
      },
      "bad confidence",
    ],
  ] as Array<[unknown, string]>) {
    it(`rejects incoherent Choice: ${label}`, () => {
      expect(() => validateChoice(answer, ["a", "b"])).toThrow();
    });
  }

  it("validates both Noul scores without forcing them to complement", () => {
    expect(validateNoul({ type: "noul", noul: 0.9 })).toBe(0.9);
    expect(validateNoul({ type: "noul", noul: 0.8 })).toBe(0.8);
    expect(() => validateNoul({ type: "noul", noul: "0.9" })).toThrow();
    expect(() => validateNoul({ type: "noul", noul: Infinity })).toThrow();
  });

  it("reports successful response cost and unknown retry total separately", () => {
    const reply = {
      model: "jev-1.13.0",
      usage: { input_tokens: 1000, output_tokens: 50 },
    };
    expect(validateCall(reply, 1)).toMatchObject({
      model: "jev-1.13.0",
      usage: { inputTokens: 1000, outputTokens: 50 },
      successfulResponseCostUsd: 0.000042,
      totalCostUsd: 0.000042,
    });
    expect(validateCall(reply, 2).totalCostUsd).toBeNull();
    expect(
      validateCall({ ...reply, model: "other-1" }, 1).successfulResponseCostUsd,
    ).toBeNull();
    expect(() =>
      validateCall(
        { ...reply, usage: { input_tokens: -1, output_tokens: 0 } },
        1,
      ),
    ).toThrow();
    expect(() =>
      validateCall(
        { ...reply, usage: { input_tokens: 1.5, output_tokens: 0 } },
        1,
      ),
    ).toThrow();
  });
});
