import { describe, expect, it } from "vitest";
import { createInterruptState } from "./interrupts.js";

describe("process interrupt boundary", () => {
  it("requests cancellation and preserves conventional signal exits", () => {
    const interrupts = createInterruptState();
    interrupts.request("SIGINT");
    expect(interrupts.signal.aborted).toBe(true);
    expect(interrupts.exitCode(0)).toBe(130);
  });

  it("ignores a late signal after the terminal outcome is committed", () => {
    const interrupts = createInterruptState();
    interrupts.commit();
    interrupts.request("SIGTERM");
    expect(interrupts.signal.aborted).toBe(false);
    expect(interrupts.exitCode(0)).toBe(0);
  });
});
