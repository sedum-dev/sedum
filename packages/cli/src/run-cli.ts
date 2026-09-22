import {
  FileClassificationCache,
  PlaywrightBrowserDriver,
  runFlow,
} from "@sedum-dev/core";
import { TypeSafeAdapter } from "@sedum-dev/provider-typesafe";
import path from "node:path";

export interface CliOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Pure argument handling; the executable owns process I/O. */
export async function runCli(
  args: readonly string[],
  version: string,
): Promise<CliOutput> {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
  }
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return {
      stdout:
        "Usage: sedum run <file.test.yaml> | sedum --version | sedum --help | sedum browsers install chromium [--with-deps]\nRun needs Chromium and TYPESAFE_API_KEY.\n",
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
    const { installChromium } = await import("@sedum-dev/core");
    const result = installChromium(args[3] === "--with-deps");
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }
  if (args.length === 2 && args[0] === "run") {
    const root = process.cwd();
    try {
      const provider = new TypeSafeAdapter();
      const cache = await FileClassificationCache.load(
        path.join(root, ".sedum", "classifications.json"),
        "jev-latest",
      );
      const result = await runFlow(args[1]!, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        provider,
        classificationCache: cache,
        env: process.env,
        headless: process.env.SEDUM_HEADED === "1" ? false : true,
      });
      if (result.status === "passed")
        return { stdout: `passed ${result.file}\n`, stderr: "", exitCode: 0 };
      if (result.status === "failed")
        return {
          stdout: `failed ${result.file}:${result.source.line}:${result.source.col}\n`,
          stderr: "",
          exitCode: 1,
        };
      return {
        stdout: "",
        stderr: `${result.source ? `${result.source.file}:${result.source.line}:${result.source.col}: ` : ""}${result.message}\n`,
        exitCode: 3,
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: `${error instanceof Error ? error.message : "Could not start Sedum."}\n`,
        exitCode: 3,
      };
    }
  }
  return {
    stdout: "",
    stderr: "Unknown or unavailable command. Use sedum --help.\n",
    exitCode: 2,
  };
}
