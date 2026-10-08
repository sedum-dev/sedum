// Summarize benchmark.mjs evidence per variant and temperature.
//
//   node evals/sentence-cache/summarize.mjs <evidence dir>
//
// Reports medians with min-max ranges, never pooled means alone, and keeps
// infrastructure failures and failed tests out of the timing samples.
import process from "node:process";
import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "");
const raw = JSON.parse(readFileSync(path.join(dir, "raw.json"), "utf8"));

function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, median, min: sorted[0], max: sorted.at(-1) };
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

const groups = {};
for (const run of raw.runs) {
  const group = (groups[`${run.variant} ${run.temperature}`] ??= {
    variant: run.variant,
    temperature: run.temperature,
    runs: [],
  });
  group.runs.push(run);
}

const summary = Object.values(groups).map(({ variant, temperature, runs }) => {
  const valid = runs.filter((run) => !run.infrastructure);
  const passed = valid.filter((run) => run.verdict === "passed");
  const located = (run) => run.actions.filter((action) => action.cache);
  return {
    variant,
    temperature,
    processes: runs.length,
    infrastructureFailures: runs.length - valid.length,
    failedTests: valid.length - passed.length,
    wallMs: stats(passed.map((run) => run.wallMs)),
    testElapsedMs: stats(passed.map((run) => run.testElapsedMs)),
    modelCalls: stats(passed.map((run) => run.totals.modelCalls)),
    costUsd: stats(passed.map((run) => run.totals.costUsd)),
    costComplete: passed.every((run) => run.totals.costComplete),
    hits: stats(
      passed.map(
        (run) =>
          located(run).filter((action) => action.cache.outcome === "hit")
            .length,
      ),
    ),
    actions: Object.fromEntries(
      (passed[0] ? located(passed[0]) : []).map((action) => [
        action.sentence,
        {
          outcomes: tally(
            passed.map((run) => {
              const same = run.actions.find((a) => a.index === action.index);
              return `${same?.cache?.outcome} ${same?.cache?.reason ?? ""}`.trim();
            }),
          ),
          admission:
            temperature === "cold"
              ? tally(passed.map((run) => run.admissions[action.index]))
              : undefined,
        },
      ]),
    ),
  };
});

writeFileSync(
  path.join(dir, "summary.json"),
  JSON.stringify({ variants: raw.variants, summary }, null, 2),
);
const fmt = (s, scale = 1, digits = 0) =>
  s
    ? `${(s.median * scale).toFixed(digits)} (${(s.min * scale).toFixed(digits)}–${(s.max * scale).toFixed(digits)})`
    : "–";
const lines = [
  "| Variant | Run | n | Failed | Wall ms | Test ms | Calls | Cost µ$ | Hits |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...summary.map(
    (row) =>
      `| ${row.variant} | ${row.temperature} | ${row.processes} | ${row.failedTests + row.infrastructureFailures} | ${fmt(row.wallMs)} | ${fmt(row.testElapsedMs)} | ${fmt(row.modelCalls, 1, 1)} | ${fmt(row.costUsd, 1e6, 1)} | ${fmt(row.hits, 1, 1)} |`,
  ),
];
writeFileSync(path.join(dir, "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
