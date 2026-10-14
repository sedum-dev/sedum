import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserPage, FrameBox, StepFrames } from "@sedum-dev/core";

/**
 * Frames of an exploration (`--replay`): the page as each click or fill was
 * about to run, with the target's box, and the page once each step settled.
 * Pages on a sensitive origin get no frame, as in `sedum run`.
 */
export class FrameRecorder {
  readonly #steps = new Map<
    number,
    { -readonly [K in keyof StepFrames]: StepFrames[K] }
  >();
  /** Frame bytes by their path in the run directory, for the HTML report. */
  readonly bytes = new Map<string, Uint8Array>();

  private constructor(
    private readonly directory: string,
    private readonly page: BrowserPage,
    private readonly sensitive: ReadonlySet<string>,
  ) {}

  static async create(
    directory: string,
    page: BrowserPage,
    sensitiveOrigins: readonly string[],
  ): Promise<FrameRecorder> {
    await mkdir(path.join(directory, "frames"), { recursive: true });
    return new FrameRecorder(directory, page, new Set(sensitiveOrigins));
  }

  get frames(): ReadonlyMap<number, StepFrames> {
    return this.#steps;
  }

  async before(step: number, box: FrameBox | null): Promise<void> {
    const file = await this.#capture(`frames/step-${step}-before.jpg`);
    if (!file) return;
    this.#frames(step).before = file;
    if (box) this.#frames(step).box = box;
  }

  async after(step: number): Promise<void> {
    const file = await this.#capture(`frames/step-${step}.jpg`);
    if (file) this.#frames(step).after = file;
  }

  #frames(step: number) {
    let frames = this.#steps.get(step);
    if (!frames) this.#steps.set(step, (frames = {}));
    return frames;
  }

  /** The frame's path in the run directory, or null when none was taken. */
  async #capture(file: string): Promise<string | null> {
    if (!this.page.captureFrame || this.#isSensitive()) return null;
    const bytes = await this.page.captureFrame().catch(() => null);
    if (!bytes) return null;
    await writeFile(path.join(this.directory, file), bytes);
    this.bytes.set(file, bytes);
    return file;
  }

  #isSensitive(): boolean {
    try {
      return this.sensitive.has(new URL(this.page.url).origin);
    } catch {
      return false;
    }
  }
}
