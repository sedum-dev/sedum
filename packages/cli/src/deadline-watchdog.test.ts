import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("run deadline watchdog", () => {
  it("exits 3 when an operation never responds to cancellation", async () => {
    const source = await readFile(
      new URL("./deadline-watchdog.ts", import.meta.url),
      "utf8",
    );
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    }).outputText;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
    const script = `import { startDeadlineWatchdog } from ${JSON.stringify(moduleUrl)}; startDeadlineWatchdog(50); await new Promise(() => {});`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script],
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
