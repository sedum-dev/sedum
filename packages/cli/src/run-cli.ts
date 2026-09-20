import { installChromium } from "@sedum-dev/core";

export interface CliOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Pure argument handling; the executable owns process I/O. */
export function runCli(args: readonly string[], version: string): CliOutput {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      stdout:
        "Usage: sedum --version | --help | browsers install chromium [--with-deps]\nThe run command is not implemented yet.\n",
      stderr: "",
      exitCode: 0,
    };
  }
  if (
    (args.length === 3 || args.length === 4) &&
    args[0] === "browsers" &&
    args[1] === "install" &&
    args[2] === "chromium" &&
    (args.length === 3 || args[3] === "--with-deps")
  ) {
    const result = installChromium(args[3] === "--with-deps");
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
  return {
    stdout: "",
    stderr: "Unknown or unavailable command. Use sedum --help.\n",
    exitCode: 2,
  };
}
