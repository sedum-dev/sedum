import { open, mkdir, rename, unlink, lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ResultFrame, RunResult } from "@sedum-dev/core";
import { validateRunResult } from "@sedum-dev/core";
import {
  renderHtml,
  renderJunit,
  renderMarkdown,
  type JunitReportOptions,
} from "@sedum-dev/reporters";

export class ProgressWriterError extends Error {
  constructor(
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not write run output at ${path}.`, options);
    this.name = "ProgressWriterError";
  }
}

/** Which files a writer produces in its run directory. */
export interface WriterFiles {
  /** `progress.json` and `result.json`. */
  readonly json: boolean;
  readonly html: boolean;
  readonly markdown: boolean;
  readonly junit: JunitReportOptions | null;
}

/** Owns only a newly created run directory, never an existing output tree. */
export class ProgressWriter {
  private revision = 0;
  private pending: Promise<void> = Promise.resolve();
  private readonly attemptFolders = new Map<string, Promise<string>>();
  private files: WriterFiles;

  private constructor(
    readonly directory: string,
    files: WriterFiles,
  ) {
    this.files = files;
  }

  static async create(
    root: string,
    runId: string,
    outputDirectory = path.join(root, ".sedum", "runs"),
    files: Partial<WriterFiles> = {},
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
    return new ProgressWriter(directory, {
      json: true,
      html: true,
      markdown: false,
      junit: null,
      ...files,
    });
  }

  get includeMarkdown(): boolean {
    return this.files.markdown;
  }
  get includesJson(): boolean {
    return this.files.json;
  }
  get includesJunit(): boolean {
    return this.files.junit !== null;
  }

  /** Add `junit.xml`, once the evidence location is known. */
  includeJunit(options: JunitReportOptions): void {
    this.files = { ...this.files, junit: options };
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
  get markdownPath(): string {
    return path.join(this.directory, "report.md");
  }
  get junitPath(): string {
    return path.join(this.directory, "junit.xml");
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

  /**
   * Write this writer's files from one validated snapshot: JSON first, then
   * the rendered reports. `reports: false` rewrites only the JSON, and
   * `json: false` renders only the reports.
   */
  async finish(
    result: RunResult,
    only: { readonly json?: boolean; readonly reports?: boolean } = {},
  ): Promise<void> {
    const json = this.files.json && only.json !== false;
    const reports = only.reports !== false;
    try {
      const snapshot = validateRunResult(result);
      if (json) {
        await this.write(snapshot);
        await this.atomicWrite(
          "result.json",
          `${JSON.stringify(snapshot, null, 2)}\n`,
        );
      }
      if (!reports) return;
      if (this.files.html) {
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
      if (this.files.markdown) {
        try {
          await this.atomicWrite("report.md", renderMarkdown(snapshot));
        } catch (cause) {
          throw new ProgressWriterError(this.markdownPath, { cause });
        }
      }
      const junit = this.files.junit;
      if (junit) {
        try {
          await this.atomicWrite("junit.xml", renderJunit(snapshot, junit));
        } catch (cause) {
          throw new ProgressWriterError(this.junitPath, { cause });
        }
      }
    } catch (cause) {
      throw cause instanceof ProgressWriterError
        ? cause
        : new ProgressWriterError(this.resultPath, { cause });
    }
  }

  /** Whether `path` is one of this writer's rendered reports. */
  isReport(target: string): boolean {
    return [this.htmlPath, this.markdownPath, this.junitPath].includes(target);
  }

  /** Remove this writer's own rendered reports after one of them failed. */
  async removeReports(): Promise<void> {
    for (const report of [this.htmlPath, this.markdownPath, this.junitPath])
      await unlink(report).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
  }

  /** Remove only this writer's non-authoritative result files after sink failure. */
  async invalidate(): Promise<void> {
    await Promise.all([
      unlink(this.progressPath).catch(() => undefined),
      unlink(this.resultPath).catch(() => undefined),
      unlink(this.htmlPath).catch(() => undefined),
      unlink(this.markdownPath).catch(() => undefined),
      unlink(this.junitPath).catch(() => undefined),
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

  /** Each attempt gets one new folder, so retries and parallel runs never share a frame file. */
  private attemptFolder(attempt: {
    readonly id: string;
    readonly ordinal: number;
  }): Promise<string> {
    const existing = this.attemptFolders.get(attempt.id);
    if (existing) return existing;
    const created = (async () => {
      const evidence = path.join(this.directory, "evidence");
      await mkdir(evidence, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const evidenceInfo = await lstat(evidence);
      if (!evidenceInfo.isDirectory() || evidenceInfo.isSymbolicLink())
        throw new Error("Evidence output path is not a directory");
      const name = `a${attempt.ordinal}-${createHash("sha256").update(attempt.id).digest("hex").slice(0, 12)}`;
      await mkdir(path.join(evidence, name), { mode: 0o700 });
      return `evidence/${name}`;
    })();
    this.attemptFolders.set(attempt.id, created);
    return created;
  }

  async saveFrame(
    attempt: { readonly id: string; readonly ordinal: number },
    frameId: string,
    bytes: Uint8Array,
  ): Promise<ResultFrame> {
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024)
      return { status: "unavailable", reason: "frame_size" };
    const folder = await this.attemptFolder(attempt);
    const name = `${createHash("sha256").update(frameId).digest("hex").slice(0, 24)}.jpg`;
    const relative = `${folder}/${name}`;
    const target = path.join(this.directory, relative);
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
      path: relative,
      mediaType: "image/jpeg",
    };
  }
}
