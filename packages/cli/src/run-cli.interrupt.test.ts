import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateRunResult } from "@sedum-dev/core";

vi.mock("@sedum-dev/provider-typesafe", () => ({ TypeSafeAdapter: class {} }));
vi.mock("@sedum-dev/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sedum-dev/core")>();
  return {
    ...actual,
    runFlow: vi.fn(
      async (_file: string, dependencies: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          const canceled = () =>
            resolve({
              status: "could_not_run",
              file: "test.yaml",
              message: "Canceled",
            });
          if (dependencies.signal?.aborted) canceled();
          else
            dependencies.signal?.addEventListener("abort", canceled, {
              once: true,
            });
        }),
    ),
  };
});

import { runCli } from "./run-cli.js";

describe("CLI in-flight cancellation", () => {
  it("writes an interrupted terminal result after an active run aborts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-cli-interrupt-"));
    const previous = process.cwd();
    try {
      process.chdir(root);
      const controller = new AbortController();
      const pending = runCli(["run", "test.yaml"], "0.0.0", {
        signal: controller.signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      const output = await pending;
      expect(output.exitCode).toBe(3);
      const match = output.stdout.match(/^progress (.+)$/mu);
      const paths = match?.[1] ? [match[1]] : [];
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
