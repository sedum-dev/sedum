import { describe, expect, it } from "vitest";
import {
  answersOf,
  validateCall,
  validateChoice,
  validateEnvelope,
  validateNoul,
} from "./validation.js";

const answer = (probabilities = { save: 0.81, none: 0.19 }) => ({
  type: "choice",
  choice: "save",
  confidence: 0.77,
  probabilities,
});
const reply = (model = "clef", input_tokens = 1250, output_tokens = 7) => ({
  model,
  usage: { input_tokens, output_tokens },
  answers: {},
});

describe("Clef response boundary", () => {
  it("preserves the complete unequal distribution without renormalizing", () => {
    expect(validateChoice(answer(), ["none", "save"])).toEqual({
      choice: "save",
      confidence: 0.77,
      probabilities: { save: 0.81, none: 0.19 },
    });
  });

  it.each([
    null,
    [],
    {},
    { ...answer(), type: "noul" },
    { ...answer(), choice: "invented" },
    { ...answer(), probabilities: { save: 0.81 } },
    { ...answer(), probabilities: { save: 0.81, other: 0.19 } },
    { ...answer(), probabilities: { save: 0.81, none: 0.19, extra: 0 } },
    { ...answer(), probabilities: { save: 0.3, none: 0.7 } },
    { ...answer(), confidence: undefined },
    { ...answer(), confidence: -0.1 },
    { ...answer(), confidence: Infinity },
    { ...answer(), probabilities: { save: NaN, none: 0.19 } },
    { ...answer(), probabilities: { save: 1.1, none: -0.1 } },
  ])("rejects malformed or incoherent Choice %#", (value) => {
    expect(() => validateChoice(value, ["save", "none"])).toThrow();
  });

  it("enforces both sides of sum and argmax tolerances", () => {
    expect(
      validateChoice(answer({ save: 0.81, none: 0.2099 }), ["save", "none"])
        .probabilities.none,
    ).toBe(0.2099);
    expect(() =>
      validateChoice(answer({ save: 0.81, none: 0.2101 }), ["save", "none"]),
    ).toThrow();
    expect(() =>
      validateChoice(answer({ save: 0.81, none: 0.1699 }), ["save", "none"]),
    ).toThrow();
    expect(
      validateChoice(answer({ save: 0.49999975, none: 0.50000025 }), [
        "save",
        "none",
      ]).choice,
    ).toBe("save");
    expect(() =>
      validateChoice(answer({ save: 0.499999, none: 0.500001 }), [
        "save",
        "none",
      ]),
    ).toThrow();
  });

  it.each([0, 0.37, 1])("accepts Noul probability %s", (noul) => {
    expect(validateNoul({ type: "noul", noul })).toBe(noul);
  });
  it.each([
    null,
    [],
    { type: "choice", noul: 0.8 },
    { type: "noul", noul: "0.8" },
    { type: "noul", noul: 1.0001 },
    { type: "noul", noul: -0.0001 },
  ])("rejects malformed Noul %#", (value) => {
    expect(() => validateNoul(value)).toThrow();
  });

  it("requires the REST envelope and record-shaped answers", () => {
    const result = reply();
    expect(
      validateEnvelope({ success: true, errors: [], messages: [], result }),
    ).toBe(result);
    expect(answersOf(result)).toEqual({});
    for (const value of [
      null,
      [],
      {},
      { success: true, errors: [], result },
      { success: true, errors: ["failure"], messages: [], result },
    ])
      expect(() => validateEnvelope(value)).toThrow();
    for (const value of [null, {}, { answers: [] }])
      expect(() => answersOf(value)).toThrow();
  });

  it("prices known returned models only, and keeps retries unknown", () => {
    expect(validateCall(reply(), { attempts: 1 }, "clef")).toMatchObject({
      provider: "clef",
      usage: { inputTokens: 1250, outputTokens: 7 },
      successfulResponseCostUsd: 0.0003,
      totalCostUsd: 0.0003,
    });
    expect(
      validateCall(
        reply("clef-flash"),
        {
          attempts: 2,
          rateLimited: true,
          queueWaitMs: 2.3,
          rateLimitWaitMs: 999.6,
        },
        "clef-flash",
      ),
    ).toMatchObject({
      successfulResponseCostUsd: 0.0001125,
      totalCostUsd: null,
      queueWaitMs: 2,
      rateLimitWaitMs: 1000,
      rateLimited: true,
    });
    for (const model of ["clef-next", "constructor", "__proto__"])
      expect(validateCall(reply(model), { attempts: 1 }, "clef")).toMatchObject(
        { requestedModel: "clef", model, rate: null, totalCostUsd: null },
      );
  });

  it.each(["", " ", "x".repeat(121)])(
    "rejects invalid model identity %#",
    (model) => {
      expect(() =>
        validateCall(reply(model), { attempts: 1 }, "clef"),
      ).toThrow();
    },
  );
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe token counts %s",
    (tokens) => {
      expect(() =>
        validateCall(reply("clef", tokens), { attempts: 1 }, "clef"),
      ).toThrow();
      expect(() =>
        validateCall(reply("clef", 1, tokens), { attempts: 1 }, "clef"),
      ).toThrow();
    },
  );
});
