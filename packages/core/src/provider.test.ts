import { describe, expect, it } from "vitest";
import {
  ProviderError,
  unknownCostCall,
  type ProviderCall,
} from "./provider.js";

describe("provider error contract", () => {
  it("serializes only stable safe fields", () => {
    const error = new ProviderError(
      "authentication",
      "TypeSafe authentication failed.",
      2,
    );
    expect(error.name).toBe("ProviderError");
    expect(error.toJSON()).toEqual({
      code: "authentication",
      message: "TypeSafe authentication failed.",
      attempts: 2,
    });
    expect(JSON.stringify(error)).not.toContain("stack");
  });

  it("uses an attached receipt without exposing it in error JSON", () => {
    const call: ProviderCall = {
      requestedModel: "jev-latest",
      model: "jev-test",
      attempts: 1,
      usage: { inputTokens: 10, outputTokens: 2 },
      rate: null,
      successfulResponseCostUsd: null,
      totalCostUsd: null,
    };
    const error = new ProviderError(
      "invalid-response",
      "Invalid response.",
      1,
      call,
    );
    expect(unknownCostCall(error)).toBe(call);
    expect(JSON.stringify(error)).not.toContain("jev-test");
  });
});
