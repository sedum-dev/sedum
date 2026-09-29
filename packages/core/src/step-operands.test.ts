import { describe, expect, it } from "vitest";
import {
  gotoUrlParts,
  pressKey,
  scrollDirection,
  waitDurationMs,
} from "./step-operands.js";

describe("step operands", () => {
  it("reads one key and normalizes it to a Playwright key name", () => {
    expect(pressKey("press Enter")).toBe("Enter");
    expect(pressKey("press enter.")).toBe("Enter");
    expect(pressKey("press the Escape key")).toBe("Escape");
    expect(pressKey("press esc")).toBe("Escape");
    expect(pressKey("press the tab key to move on")).toBe("Tab");
    expect(pressKey('press "Control+A"')).toBe("Control+A");
    expect(pressKey('press "cmd + k"')).toBe("Meta+k");
    expect(pressKey("press F5")).toBe("F5");
    expect(pressKey("press a")).toBe("a");
    expect(pressKey("press the banana key")).toBeNull();
    expect(pressKey('press "Hyper+A"')).toBeNull();
  });

  it("reads a wait duration within the documented bound", () => {
    expect(waitDurationMs("wait 1 second")).toBe(1000);
    expect(waitDurationMs("wait for 2.5 seconds")).toBe(2500);
    expect(waitDurationMs("wait 250 ms")).toBe(250);
    expect(waitDurationMs("wait 31 seconds")).toBeNull();
    expect(waitDurationMs("wait 0 s")).toBeNull();
    expect(waitDurationMs("wait a moment")).toBeNull();
  });

  it("reads a scroll direction", () => {
    expect(scrollDirection("scroll down")).toBe("down");
    expect(scrollDirection("Scroll up to the header")).toBe("up");
    expect(scrollDirection("scroll sideways")).toBeNull();
  });

  it("splits a goto address around placeholders", () => {
    expect(gotoUrlParts("goto https://example.test/a.")).toEqual({
      literals: ["https://example.test/a"],
      names: [],
    });
    expect(gotoUrlParts("go to https://example.test/{{id}}/x?q={{q}}")).toEqual(
      {
        literals: ["https://example.test/", "/x?q=", ""],
        names: ["id", "q"],
      },
    );
    expect(gotoUrlParts("goto the home page")).toBeNull();
  });
});
