import { open, mkdir, rename, unlink, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ResultFrame, RunResult } from "@sedum-dev/core";
import { validateRunResult } from "@sedum-dev/core";
import { renderHtml } from "@sedum-dev/reporters";

export class ProgressWriterError extends Error {
  constructor(
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not write run output at ${path}.`, options);
    this.name = "ProgressWriterError";
  }
}

/** Owns only a newly created run directory, never an existing output tree. */
export class ProgressWriter {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(
    readonly directory: string,
    private readonly includeHtml: boolean,
  ) {}

  static async create(
    root: string,
    runId: string,
    outputDirectory = path.join(root, ".sedum", "runs"),
    includeHtml = true,
  ): Promise<ProgressWriter> {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid run ID");
    const resolvedRoot = path.resolve(root);
    const base = path.resolve(outputDirectory);
    const relation = path.relative(resolvedRoot, base);
    if (relation === ".." || relation.startsWith(`..${path.sep}`))
      throw new Error("Run output path escapes the project root");
    let part = resolvedRoot;
    for (const segment of relation.split(path.sep).filter(Boolean)) {
      part = path.join(part, segment);
      await mkdir(part, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(part);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Run output parent is not a directory");
    }
    const directory = path.join(base, runId);
    await mkdir(directory, { mode: 0o700 });
    return new ProgressWriter(directory, includeHtml);
  }

  get progressPath(): string {
    return path.join(this.directory, "progress.json");
  }
  get resultPath(): string {
    return path.join(this.directory, "result.json");
  }
  get htmlPath(): string {
    return path.join(this.directory, "report.html");
  }

  private async atomicWrite(name: string, content: string): Promise<void> {
    const target = path.join(this.directory, name);
    const temporary = path.join(
      this.directory,
      `.${name}.${++this.revision}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      const existing = await lstat(target).catch(() => null);
      if (existing?.isSymbolicLink())
        throw new Error("Output path is a symlink");
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  write(result: RunResult): Promise<void> {
    const snapshot = validateRunResult(result);
    this.pending = this.pending.then(() =>
      this.atomicWrite(
        "progress.json",
        `${JSON.stringify(snapshot, null, 2)}\n`,
      ),
    );
    return this.pending.catch((cause: unknown) => {
      throw cause instanceof ProgressWriterError
        ? cause
        : new ProgressWriterError(this.progressPath, { cause });
    });
  }

  async finish(
    result: RunResult,
    includeHtml = this.includeHtml,
  ): Promise<void> {
    try {
      await this.write(result);
      const snapshot = validateRunResult(result);
      await this.atomicWrite(
        "result.json",
        `${JSON.stringify(snapshot, null, 2)}\n`,
      );
      if (includeHtml) {
        try {
          const frames = await this.loadReplayFrames(snapshot);
          await this.atomicWrite(
            "report.html",
            renderHtml(snapshot, frames ? { replayFrames: frames } : {}),
          );
        } catch (cause) {
          throw new ProgressWriterError(this.htmlPath, { cause });
        }
      }
    } catch (cause) {
      throw cause instanceof ProgressWriterError
        ? cause
        : new ProgressWriterError(this.resultPath, { cause });
    }
  }

  async removeHtml(): Promise<void> {
    await unlink(this.htmlPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }

  /** Remove only this writer's non-authoritative result files after sink failure. */
  async invalidate(): Promise<void> {
    await Promise.all([
      unlink(this.progressPath).catch(() => undefined),
      unlink(this.resultPath).catch(() => undefined),
      unlink(this.htmlPath).catch(() => undefined),
    ]);
  }

  private async loadReplayFrames(
    result: RunResult,
  ): Promise<Map<string, string> | undefined> {
    const paths = result.tests.flatMap((test) =>
      test.attempts.flatMap((attempt) =>
        attempt.steps.flatMap((step) =>
          step.replayFrame?.status === "captured"
            ? [step.replayFrame.path]
            : [],
        ),
      ),
    );
    const hasReplay = result.tests.some((test) =>
      test.attempts.some((attempt) =>
        attempt.steps.some((step) => step.replayFrame !== null),
      ),
    );
    if (!hasReplay) return undefined;
    const frames = new Map<string, string>();
    for (const relative of new Set(paths)) {
      try {
        let current = this.directory;
        const segments = relative.split("/");
        for (const [index, segment] of segments.entries()) {
          current = path.join(current, segment);
          const info = await lstat(current);
          if (
            info.isSymbolicLink() ||
            (index < segments.length - 1 ? !info.isDirectory() : !info.isFile())
          )
            throw new Error("Unsafe frame path");
          if (index === segments.length - 1 && info.size > 5 * 1024 * 1024)
            throw new Error("Frame exceeds capture limit");
        }
        const bytes = await readFile(current);
        if (
          bytes.length > 5 * 1024 * 1024 ||
          bytes.length < 4 ||
          bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 ||
          bytes[bytes.length - 2] !== 0xff ||
          bytes[bytes.length - 1] !== 0xd9
        )
          throw new Error("Invalid JPEG frame");
        frames.set(relative, bytes.toString("base64"));
      } catch {
        // A frame may be omitted or unavailable after capture; the report labels it.
      }
    }
    return frames;
  }

  async saveFrame(stepId: string, bytes: Uint8Array): Promise<ResultFrame> {
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024)
      return { status: "unavailable", reason: "frame_size" };
    const folder = path.join(this.directory, "evidence");
    await mkdir(folder, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const folderInfo = await lstat(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink())
      throw new Error("Evidence output path is not a directory");
    const name = `${createHash("sha256").update(stepId).digest("hex").slice(0, 24)}.jpg`;
    const target = path.join(folder, name);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(target).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
    return {
      status: "captured",
      path: `evidence/${name}`,
      mediaType: "image/jpeg",
    };
  }
}
