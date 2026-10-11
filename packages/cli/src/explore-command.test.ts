import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import {
  exploreMode,
  seedValue,
  startUrl,
  watchOrigin,
} from "./explore-command.js";
import { runCli } from "./run-cli.js";

describe("explore arguments", () => {
  it("accepts seeds, modes and absolute web URLs", () => {
    expect(seedValue("0")).toBe(0);
    expect(seedValue("2147483647")).toBe(2147483647);
    expect(exploreMode("random")).toBe("random");
    expect(startUrl("https://example.test/a")).toBe("https://example.test/a");
  });

  it("collects watched origins", () => {
    expect(watchOrigin("https://api.example.test/v1")).toEqual([
      "https://api.example.test",
    ]);
    expect(watchOrigin("https://b.test", ["https://a.test"])).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("rejects malformed values", () => {
    for (const bad of ["-1", "1.5", "2147483648", "x", ""])
      expect(() => seedValue(bad)).toThrow(InvalidArgumentError);
    expect(() => exploreMode("smart")).toThrow(InvalidArgumentError);
    expect(() => startUrl("file:///etc/passwd")).toThrow(InvalidArgumentError);
    expect(() => startUrl("/relative")).toThrow(InvalidArgumentError);
  });

  it("needs a start URL unless it replays a trace", async () => {
    const output = await runCli(["explore", "--mode", "random"], "0.0.0");
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("Missing start URL");
  });
});
