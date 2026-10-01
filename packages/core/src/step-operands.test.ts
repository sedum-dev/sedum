import { describe, expect, it } from "vitest";
import { patternOperation, validateOperand } from "./classification.js";
import {
  gotoPathParts,
  gotoUrlParts,
  historyMove,
  pressKey,
  scrollDirection,
  waitDurationMs,
  waitUntilTimeoutMs,
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

describe("history and path navigation", () => {
  it("reads a move in the browser history", () => {
    expect(historyMove("go back")).toBe("back");
    expect(historyMove("go back to the previous page.")).toBe("back");
    expect(historyMove("navigate forward")).toBe("forward");
    expect(historyMove("reload the page")).toBe("reload");
    expect(historyMove("refresh")).toBe("reload");
    expect(historyMove("go back to the cart")).toBeNull();
  });

  it("splits a path on the current site around its values", () => {
    expect(gotoPathParts("goto /practice/workspace")).toEqual({
      literals: ["/practice/workspace"],
      names: [],
    });
    expect(gotoPathParts("go to /clients/{{id}}/overview")).toEqual({
      literals: ["/clients/", "/overview"],
      names: ["id"],
    });
    expect(gotoPathParts("goto https://example.com/")).toBeNull();
    expect(gotoPathParts("goto the clients page")).toBeNull();
  });

  it("classifies history moves and paths as navigations offline", () => {
    for (const sentence of [
      "go back",
      "reload the page",
      "goto /practice/clients",
      "navigate to /clients/{{id}}",
    ]) {
      expect(patternOperation(sentence)).toBe("goto");
      expect(validateOperand(sentence, "goto")).toBeNull();
    }
    expect(validateOperand("goto the clients page", "goto")).not.toBeNull();
  });
});

describe("wait until a claim holds", () => {
  it("classifies a wait for a claim as a verify, and a wait for a time as a wait", () => {
    expect(patternOperation("wait until the reply is shown")).toBe("verify");
    expect(
      patternOperation(
        "wait up to 90 seconds until the reply is shown and the list is updated",
      ),
    ).toBe("verify");
    expect(patternOperation("wait for the Save button to be enabled")).toBe(
      "verify",
    );
    expect(patternOperation("wait for 2 seconds")).toBe("wait");
    expect(patternOperation("wait 500 ms")).toBe("wait");
  });

  it("reads how long a wait may judge its claim", () => {
    expect(waitUntilTimeoutMs("wait until the reply is shown")).toBe(30_000);
    expect(
      waitUntilTimeoutMs("wait up to 90 seconds until the reply is shown"),
    ).toBe(90_000);
    expect(
      waitUntilTimeoutMs("wait up to 600 seconds until the reply is shown"),
    ).toBe(120_000);
    expect(waitUntilTimeoutMs("wait for 2 seconds")).toBeNull();
    expect(waitUntilTimeoutMs("verify the reply is shown")).toBeNull();
  });
});
