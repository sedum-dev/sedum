import { describe, expect, it } from "vitest";
import { ProviderError } from "./provider.js";

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
});
