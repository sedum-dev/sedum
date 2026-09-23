import {
  mkdtemp,
  readFile,
  rm,
  lstat,
  symlink,
  readdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunRecorder,
  validateRunResult,
  type ResultStep,
} from "@sedum-dev/core";
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
      const html = await readFile(writer.htmlPath, "utf8");
      expect(html).toContain("The provider is unavailable.");
      expect(html).toContain("run receipt");
      expect(html).not.toContain("data:image/jpeg;base64");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("embeds captured replay JPEGs and rejects symlinked frame references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-html-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sedum-frame-"));
    try {
      const writer = await ProgressWriter.create(root, "run-frames");
      const frame = await writer.saveFrame(
        "step-1",
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      );
      expect(frame.status).toBe("captured");
      if (frame.status !== "captured") throw new Error("Missing frame");
      await writeFile(
        path.join(outside, "secret.jpg"),
        new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      );
      await symlink(
        path.join(outside, "secret.jpg"),
        path.join(writer.directory, "evidence", "linked.jpg"),
      );
      const recorder = new RunRecorder(async () => {}, "run-frames");
      await recorder.start();
      await recorder.startTest({ id: "one", file: "one.test.yaml" });
      const base: ResultStep = {
        id: "step-1",
        index: 1,
        kind: "action",
        operation: "click",
        phase: "steps",
        sentence: "click Save",
        detail: "",
        sourceStack: [{ file: "one.test.yaml", line: 3, col: 5 }],
        state: "completed",
        verdict: "passed",
        flags: [],
        elapsedMs: 10,
        page: { status: "omitted", reason: "sensitive" },
        locator: null,
        judgement: null,
        observations: [],
        calls: [],
        error: null,
        evidence: { status: "omitted", reason: "disabled" },
        replayFrame: frame,
        targetBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      };
      await recorder.addStep(base);
      await recorder.addStep({
        ...base,
        id: "step-2",
        index: 2,
        replayFrame: {
          status: "captured",
          path: "evidence/linked.jpg",
          mediaType: "image/jpeg",
        },
      });
      await recorder.finishTest("passed");
      await recorder.finish();
      await writer.finish(recorder.snapshot);
      const html = await readFile(writer.htmlPath, "utf8");
      expect(html).toContain("data:image/jpeg;base64,/9j/2Q==");
      expect(html).toContain('"status":"unavailable"');
      expect(html.match(/data:image\/jpeg;base64,/g)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
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
