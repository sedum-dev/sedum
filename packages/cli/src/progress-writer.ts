import { open, mkdir, rename, unlink, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ResultFrame, RunResult } from "@sedum-dev/core";
import { validateRunResult } from "@sedum-dev/core";

/** Owns only a newly created run directory, never an existing output tree. */
export class ProgressWriter {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();

  private constructor(readonly directory: string) {}

  static async create(root: string, runId: string): Promise<ProgressWriter> {
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid run ID");
    const parent = path.join(root, ".sedum");
    const base = path.join(parent, "runs");
    for (const part of [parent, base]) {
      await mkdir(part, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(part);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Run output parent is not a directory");
    }
    const directory = path.join(base, runId);
    await mkdir(directory, { mode: 0o700 });
    return new ProgressWriter(directory);
  }

  get progressPath(): string {
    return path.join(this.directory, "progress.json");
  }
  get resultPath(): string {
    return path.join(this.directory, "result.json");
  }

  private async atomicWrite(name: string, result: RunResult): Promise<void> {
    const target = path.join(this.directory, name);
    const temporary = path.join(
      this.directory,
      `.${name}.${++this.revision}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`);
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
      this.atomicWrite("progress.json", snapshot),
    );
    return this.pending;
  }

  async finish(result: RunResult): Promise<void> {
    await this.write(result);
    await this.atomicWrite("result.json", validateRunResult(result));
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
