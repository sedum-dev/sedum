import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("run deadline watchdog", () => {
  it("exits 3 when an operation never responds to cancellation", async () => {
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, "deadline-watchdog.ts"),
    ).href;
    const script = `import { startDeadlineWatchdog } from ${JSON.stringify(moduleUrl)}; startDeadlineWatchdog(50); await new Promise(() => {});`;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { stdio: "ignore" },
    );
    const code = await new Promise<number | null>((resolve, reject) => {
      const limit = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("The watchdog did not bound the child process."));
      }, 3_000);
      child.once("error", (error) => {
        clearTimeout(limit);
        reject(error);
      });
      child.once("exit", (exitCode) => {
        clearTimeout(limit);
        resolve(exitCode);
      });
    });
    expect(code).toBe(3);
  });
});
