import { readFileSync } from "node:fs";
import process from "node:process";
import console from "node:console";
import { split } from "./lib/score.mjs";

/**
 * Tools for stored locator eval runs.
 *
 *   node evals/locator/triage.mjs split <run.json>...
 *
 * `split` prints extraction, choice, and top pick for each run, so runs from
 * before the split was reported can be compared on the same terms.
 */
const [command, ...files] = process.argv.slice(2);
const percent = (value) =>
  value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`.padStart(6);

if (command !== "split" || files.length === 0) {
  console.error("Usage: node evals/locator/triage.mjs split <run.json>...");
  process.exit(2);
}
console.log("extraction  choice  top pick  run");
for (const file of files) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const result = split(run.results);
  console.log(
    `${percent(result.extraction)}      ${percent(result.choice)}  ${percent(result.topPick)}    ${file}`,
  );
}
