import { describe, expect, it } from "vitest";
import { verifyGraceMs } from "./support.js";

describe("verifyGraceMs", () => {
  it("accepts every generated finite duration inside the documented range", () => {
    let state = 0x5ed013;
    for (let index = 0; index < 1_000; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const duration = (state / 0xffffffff) * 120_000;
      expect(verifyGraceMs(String(duration))).toBe(duration);
    }
  });

  it("rejects generated finite durations outside the documented range", () => {
    for (let index = 1; index <= 1_000; index++) {
      expect(verifyGraceMs(String(-index / 10))).toBe(5_000);
      expect(verifyGraceMs(String(120_000 + index / 10))).toBe(5_000);
    }
  });
});
