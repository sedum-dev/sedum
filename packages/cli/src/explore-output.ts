import { writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExploreResult,
  ExploreRunMeta,
  ExploreRunResult,
} from "@sedum-dev/core";

/** The files one exploration writes next to its trace. */
export interface ExploreReports {
  readonly result: string;
  readonly markdown: string;
  readonly html: string;
}

/**
 * Write `result.json`, `report.md` and `report.html` into the run
 * directory, as `sedum run` does. Paths inside them are relative to it.
 */
export async function writeExploreReports(
  directory: string,
  result: ExploreResult,
  meta: ExploreRunMeta,
  frames: ReadonlyMap<string, Uint8Array>,
): Promise<{ run: ExploreRunResult; files: ExploreReports }> {
  const { buildExploreRunResult } = await import("@sedum-dev/core");
  const { renderExploreHtml, renderExploreMarkdown } =
    await import("@sedum-dev/reporters");
  const run = buildExploreRunResult(result, meta);
  const files = {
    result: path.join(directory, "result.json"),
    markdown: path.join(directory, "report.md"),
    html: path.join(directory, "report.html"),
  };
  await writeFile(files.result, `${JSON.stringify(run, null, 2)}\n`);
  await writeFile(files.markdown, renderExploreMarkdown(run));
  await writeFile(files.html, renderExploreHtml(run, { frames }));
  return { run, files };
}
