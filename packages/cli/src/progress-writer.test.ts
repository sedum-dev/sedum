import {
  mkdtemp,
  readFile,
  rm,
  lstat,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunRecorder, validateRunResult } from "@sedum-dev/core";
import { ProgressWriter } from "./progress-writer.js";

describe("live progress writer", () => {
  it("publishes parseable progress before a terminal result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-progress-"));
    try {
      const writer = await ProgressWriter.create(root, "run-1");
      const recorder = new RunRecorder((value) => writer.write(value), "run-1");
      await recorder.start();
      expect(
        validateRunResult(
          JSON.parse(await readFile(writer.progressPath, "utf8")),
        ).state,
      ).toBe("running");
      await recorder.finish({
        code: "missing_key",
        message: "The provider is unavailable.",
      });
      await writer.finish(recorder.snapshot);
      const progress = validateRunResult(
        JSON.parse(await readFile(writer.progressPath, "utf8")),
      );
      const final = validateRunResult(
        JSON.parse(await readFile(writer.resultPath, "utf8")),
      );
      expect(progress).toEqual(final);
      expect(final).toMatchObject({
        state: "error",
        verdict: null,
        totals: { executedTests: 0 },
      });
      expect((await lstat(writer.directory)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked output parent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-progress-"));
    const elsewhere = await mkdtemp(path.join(tmpdir(), "sedum-elsewhere-"));
    try {
      await symlink(elsewhere, path.join(root, ".sedum"));
      await expect(ProgressWriter.create(root, "run-2")).rejects.toThrow();
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
