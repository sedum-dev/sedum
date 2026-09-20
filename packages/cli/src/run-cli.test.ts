import { describe, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

describe("CLI arguments", () => {
  it("prints the supplied package version", () => {
    expect(runCli(["--version"], "1.2.3")).toEqual({
      stdout: "1.2.3\n",
      stderr: "",
      exitCode: 0,
    });
    expect(runCli(["-v"], "1.2.3").exitCode).toBe(0);
  });

  it("explains the available surface", () => {
    expect(runCli(["--help"], "1.2.3").stdout).toContain(
      "run command is not implemented",
    );
    expect(runCli(["-h"], "1.2.3").exitCode).toBe(0);
  });

  it("fails clearly for unavailable or malformed commands", () => {
    for (const args of [[], ["run"], ["--version", "extra"], ["--unknown"]]) {
      expect(runCli(args, "1.2.3")).toEqual({
        stdout: "",
        stderr: "Unknown or unavailable command. Use sedum --help.\n",
        exitCode: 2,
      });
    }
  });
});
