import {
  mkdir,
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
import { describe, expect, it, vi } from "vitest";
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
        { id: "attempt-1", ordinal: 1 },
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

  it("keeps every attempt's frames in its own new folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-evidence-"));
    try {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      const first = await ProgressWriter.create(root, "run-a");
      const second = await ProgressWriter.create(root, "run-b");
      const saved = await Promise.all([
        first.saveFrame({ id: "run-a:attempt:1", ordinal: 1 }, "s1:e", jpeg),
        first.saveFrame({ id: "run-a:attempt:1", ordinal: 1 }, "s1:r", jpeg),
        first.saveFrame({ id: "run-a:attempt:2", ordinal: 2 }, "s1:e", jpeg),
        second.saveFrame({ id: "run-b:attempt:1", ordinal: 1 }, "s1:e", jpeg),
      ]);
      const paths = saved.map((frame) =>
        frame.status === "captured" ? frame.path : frame.status,
      );
      for (const item of paths)
        expect(item).toMatch(
          /^evidence\/a[12]-[0-9a-f]{12}\/[0-9a-f]{24}\.jpg$/u,
        );
      expect(paths[0]!.split("/")[1]).toBe(paths[1]!.split("/")[1]);
      expect(paths[0]!.split("/")[1]).not.toBe(paths[2]!.split("/")[1]);
      expect(paths[0]).not.toBe(paths[2]);
      expect(paths[2]!.split("/")[1]).toMatch(/^a2-/u);
      const files = [
        path.join(first.directory, paths[0]!),
        path.join(first.directory, paths[1]!),
        path.join(first.directory, paths[2]!),
        path.join(second.directory, paths[3]!),
      ];
      expect(new Set(files).size).toBe(4);
      for (const file of files) expect((await lstat(file)).isFile()).toBe(true);
      await expect(
        first.saveFrame({ id: "run-a:attempt:1", ordinal: 1 }, "s1:e", jpeg),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never writes into an attempt folder or evidence link it did not create", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-evidence-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sedum-outside-"));
    try {
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      const writer = await ProgressWriter.create(root, "run-c");
      const attempt = { id: "run-c:attempt:1", ordinal: 1 };
      const probe = await ProgressWriter.create(root, "run-probe");
      const frame = await probe.saveFrame(attempt, "x", jpeg);
      if (frame.status !== "captured") throw new Error("Missing frame");
      const folder = frame.path.split("/")[1]!;
      await mkdir(path.join(writer.directory, "evidence", folder), {
        recursive: true,
      });
      await expect(writer.saveFrame(attempt, "x", jpeg)).rejects.toThrow();
      const linked = await ProgressWriter.create(root, "run-d");
      await symlink(outside, path.join(linked.directory, "evidence"));
      await expect(
        linked.saveFrame({ id: "run-d:attempt:1", ordinal: 1 }, "x", jpeg),
      ).rejects.toThrow();
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes report.md from the final result when markdown is on", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-markdown-"));
    try {
      const writer = await ProgressWriter.create(
        root,
        "run-md",
        undefined,
        true,
        true,
      );
      const recorder = new RunRecorder(async () => {}, "run-md");
      await recorder.start();
      await recorder.finish({ code: "missing_key", message: "No key." });
      await writer.finish(recorder.snapshot);
      const markdown = await readFile(writer.markdownPath, "utf8");
      expect(markdown).toContain("**error**");
      expect(markdown).toContain("`missing_key` — No key.");
      await writer.invalidate();
      await expect(readFile(writer.markdownPath, "utf8")).rejects.toThrow();
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

  it("coalesces queued snapshots to the newest one and keeps progress monotonic", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-progress-"));
    try {
      const writer = await ProgressWriter.create(root, "run-burst");
      const writes = vi.spyOn(
        writer as unknown as { atomicWrite: () => Promise<void> },
        "atomicWrite",
      );
      const recorder = new RunRecorder(async () => undefined, "run-burst");
      await recorder.start();
      const snapshots = [];
      for (let count = 1; count <= 20; count++) {
        await recorder.selectTests(count);
        snapshots.push(recorder.snapshot);
      }
      await Promise.all(snapshots.map((snapshot) => writer.write(snapshot)));
      expect(writes.mock.calls.length).toBeLessThan(snapshots.length);
      const progress = validateRunResult(
        JSON.parse(await readFile(writer.progressPath, "utf8")),
      );
      expect(progress.selectedTestCount).toBe(20);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps failing every later write after one progress write fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-progress-"));
    try {
      const writer = await ProgressWriter.create(root, "run-fail");
      const recorder = new RunRecorder(async () => undefined, "run-fail");
      await recorder.start();
      vi.spyOn(
        writer as unknown as { atomicWrite: () => Promise<void> },
        "atomicWrite",
      ).mockRejectedValueOnce(new Error("disk full"));
      await expect(writer.write(recorder.snapshot)).rejects.toThrow();
      await expect(writer.write(recorder.snapshot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
