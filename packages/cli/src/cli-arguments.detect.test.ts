import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { collectAllowRule, detectMode } from "./cli-arguments.js";

describe("--detect and --detect-allow", () => {
  it("accepts the detector modes", () => {
    expect(detectMode("browser")).toBe("browser");
    expect(detectMode(" off ")).toBe("off");
    expect(detectMode("semantic")).toBe("semantic");
    expect(() => detectMode("all")).toThrow(InvalidArgumentError);
  });

  it("collects allow rules and rejects an invalid regular expression", () => {
    expect(
      collectAllowRule("console_error:re:^Warning", ["http_error:/favicon"]),
    ).toEqual(["http_error:/favicon", "console_error:re:^Warning"]);
    expect(() => collectAllowRule("re:(", [])).toThrow(InvalidArgumentError);
  });
});
