import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateRunResult } from "@sedum-dev/core";

vi.mock("@sedum-dev/provider-typesafe", () => ({
  TypeSafeAdapter: class {
    constructor() {
      throw new Error("No provider key");
    }
  },
}));

import { runCli } from "./run-cli.js";

describe("CLI early progress", () => {
  it("creates progress before provider setup and closes it on error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-cli-progress-"));
    const previous = process.cwd();
    try {
      process.chdir(root);
      await writeFile(
        path.join(root, "missing.test.yaml"),
        "url: https://example.test\nsteps: [verify page]\n",
      );
      const paths: string[] = [];
      const output = await runCli(["run", "missing.test.yaml"], "0.0.0");
      expect(output.exitCode).toBe(3);
      const match = output.stdout.match(/^progress (.+)$/mu);
      if (match?.[1]) paths.push(match[1]);
      expect(paths).toHaveLength(1);
      const progress = validateRunResult(
        JSON.parse(await readFile(paths[0]!, "utf8")),
      );
      const result = validateRunResult(
        JSON.parse(
          await readFile(
            path.join(path.dirname(paths[0]!), "result.json"),
            "utf8",
          ),
        ),
      );
      expect(progress).toEqual(result);
      expect(result).toMatchObject({
        state: "error",
        verdict: null,
        error: { code: "setup_or_output_error" },
        totals: { executedTests: 0 },
      });
      expect(JSON.stringify(result)).not.toContain("No provider key");
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("terminalizes an aborted run as interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-cli-cancel-"));
    const previous = process.cwd();
    try {
      process.chdir(root);
      await writeFile(
        path.join(root, "missing.test.yaml"),
        "url: https://example.test\nsteps: [verify page]\n",
      );
      const controller = new AbortController();
      controller.abort();
      const paths: string[] = [];
      const output = await runCli(["run", "missing.test.yaml"], "0.0.0", {
        signal: controller.signal,
      });
      expect(output.exitCode).toBe(3);
      const match = output.stdout.match(/^progress (.+)$/mu);
      if (match?.[1]) paths.push(match[1]);
      const progress = validateRunResult(
        JSON.parse(await readFile(paths[0]!, "utf8")),
      );
      const result = validateRunResult(
        JSON.parse(
          await readFile(
            path.join(path.dirname(paths[0]!), "result.json"),
            "utf8",
          ),
        ),
      );
      expect(progress).toEqual(result);
      expect(result).toMatchObject({
        state: "interrupted",
        verdict: null,
        error: { code: "canceled" },
      });
    } finally {
      process.chdir(previous);
      await rm(root, { recursive: true, force: true });
    }
  });
});
