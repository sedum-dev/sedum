// Cold/warm sentence-cache benchmark across Sedum builds.
//
//   node evals/sentence-cache/benchmark.mjs --out <new dir> --pairs 6 \
//     --variant stock=<checkout> --variant grammar=<checkout> ...
//
// Each variant is a built Sedum checkout. Every pair gets a fresh fixture copy
// with its own Git metadata, so caches never cross pairs or variants; cold and
// warm are separate CLI processes with fresh browser contexts. Variant order
// rotates per pair. Provider credentials come from the environment only.
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const FIXTURE_SHA256 = {
  "tests/sentences.test.ts":
    "209423fdeda92acfd0e81311656e93c9318bed11c8d9b951cfcd4f8b6e31f967",
  "tests/support/saucedemo.ts":
    "30f443535e9721b2e91c8c573e3bbbaa9e2b1f5b9a1ff3d5501ccb0ca1b42327",
};
const TEST = "tests/sentences.test.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    pairs: { type: "string", default: "6" },
    variant: { type: "string", multiple: true },
    fixture: {
      type: "string",
      default: path.join(import.meta.dirname, "fixture"),
    },
  },
});
if (!values.out || !values.variant?.length)
  throw new Error("Usage: --out <new dir> --variant name=<checkout> [...]");
const out = path.resolve(values.out);
if (existsSync(out))
  throw new Error(`Refusing existing evidence directory ${out}`);
const pairs = Number(values.pairs);
if (!Number.isInteger(pairs) || pairs < 1) throw new Error("Bad --pairs");
const fixture = path.resolve(values.fixture);

const sha256 = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
for (const [file, digest] of Object.entries(FIXTURE_SHA256))
  if (sha256(path.join(fixture, file)) !== digest)
    throw new Error(`Fixture ${file} does not match the recorded checksum`);

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
const variants = values.variant.map((spec) => {
  const [name, dir] = spec.split("=");
  const root = path.resolve(dir);
  const cli = path.join(root, "packages/cli/dist/cli.js");
  if (!name || !existsSync(cli)) throw new Error(`Unbuilt variant ${spec}`);
  const sources = ["page-cache.ts", "sentence-context.ts"]
    .map((file) => path.join(root, "packages/core/src", file))
    .filter(existsSync);
  return {
    name,
    root,
    cli,
    revision: git(root, "rev-parse", "HEAD"),
    dirty: git(root, "status", "--porcelain") !== "",
    sources: Object.fromEntries(
      sources.map((file) => [path.relative(root, file), sha256(file)]),
    ),
  };
});

mkdirSync(out, { recursive: true });
const raw = {
  startedAt: new Date().toISOString(),
  node: process.version,
  fixture: FIXTURE_SHA256,
  variants,
  runs: [],
};
const save = () =>
  writeFileSync(path.join(out, "raw.json"), JSON.stringify(raw, null, 2));
save();

function resultFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((file) => path.basename(String(file)) === "result.json")
    .map((file) => path.join(dir, String(file)));
}

/** The cache key a step used: the runner drops a type step's value operand. */
function cacheSentence(step) {
  if (step.operation !== "type") return step.sentence;
  return step.sentence.replace(/\{\{[^{}]+\}\}/u, "").replace(/\s+/gu, " ");
}

async function admissions(variant, workdir, steps) {
  const cache = path.join(workdir, ".git/sedum/locator-cache");
  if (!existsSync(path.join(cache, "key"))) return {};
  const core = await import(
    pathToFileURL(path.join(variant.root, "packages/core/dist/index.js")).href
  );
  const key = new Uint8Array(readFileSync(path.join(cache, "key")));
  const admitted = {};
  for (const step of steps) {
    if (!step.locator || step.page?.status !== "available") continue;
    const op = step.operation === "type" ? "fill" : "click";
    const digest = core.pageKey(
      key,
      step.page.url,
      op,
      cacheSentence(step).trim(),
    );
    const file = path.join(cache, "entries", `${digest}.json`);
    const plain = path.join(cache, "entries", digest);
    const found = [file, plain].find(existsSync);
    admitted[step.index] = !found
      ? "not_stored"
      : JSON.parse(readFileSync(found, "utf8")).boundedContext
        ? "bounded"
        : "other";
  }
  return admitted;
}

/** The single executed attempt of the fixture's single test, or nothing. */
function attempt(report) {
  return report?.tests?.[0]?.attempts?.at(-1) ?? { steps: [] };
}

function action(step) {
  const calls = step.calls ?? [];
  return {
    index: step.index,
    operation: step.operation,
    sentence: step.sentence,
    verdict: step.verdict,
    source: step.locator?.source ?? null,
    cache: step.locator?.cache ?? null,
    calls: calls.length,
    costUsd: calls.reduce((sum, call) => sum + call.costUsd, 0),
  };
}

function runOnce(variant, workdir, id) {
  const output = path.join(".sedum", id);
  const args = [
    variant.cli,
    "run",
    TEST,
    "--parallel",
    "1",
    "--retries",
    "0",
    "--locator-cache-ci",
    "--output-dir",
    output,
    "--reporter-dir",
    output,
    "--reporter",
    "json",
    "--costs",
  ];
  const started = performance.now();
  const child = spawnSync(process.execPath, args, {
    cwd: workdir,
    encoding: "utf8",
    timeout: 240_000,
  });
  const wallMs = performance.now() - started;
  writeFileSync(path.join(out, `${id}.stdout.txt`), child.stdout ?? "");
  writeFileSync(path.join(out, `${id}.stderr.txt`), child.stderr ?? "");
  const files = resultFiles(path.join(workdir, output));
  if (files.length === 1) cpSync(files[0], path.join(out, `${id}.result.json`));
  return { child, wallMs, files };
}

const seenRuns = new Set();

/** One parsed result per process with a new run ID, or why not. */
function readReport(files) {
  if (files.length !== 1) return { problem: `result files: ${files.length}` };
  const report = JSON.parse(readFileSync(files[0], "utf8"));
  if (seenRuns.has(report.runId)) return { problem: "reused run id" };
  seenRuns.add(report.runId);
  if (!report.totals?.executedTests) return { problem: "no executed test" };
  return { report };
}

function record(base, report) {
  const last = attempt(report);
  return {
    ...base,
    runId: report?.runId ?? null,
    verdict: report?.tests?.[0]?.verdict ?? null,
    testElapsedMs: last.elapsedMs ?? null,
    totals: report?.totals ?? null,
    actions: last.steps.map(action),
  };
}

async function measureRun(variant, pair, workdir, temperature) {
  const id = `${variant.name}-${pair}-${temperature}`;
  const { child, wallMs, files } = runOnce(variant, workdir, id);
  const { report, problem } = readReport(files);
  const run = record(
    {
      id,
      variant: variant.name,
      pair,
      temperature,
      exitCode: child.status,
      signal: child.signal,
      error: child.error?.message ?? null,
      infrastructure: problem ?? null,
      wallMs,
    },
    report,
  );
  run.admissions =
    temperature === "cold"
      ? await admissions(variant, workdir, attempt(report).steps)
      : {};
  raw.runs.push(run);
  save();
  console.log(id, child.status, Math.round(wallMs), run.verdict);
}

async function measure(variant, pair) {
  const workdir = path.join(out, "work", `${variant.name}-${pair}`);
  cpSync(fixture, workdir, { recursive: true });
  git(workdir, "init", "-q");
  for (const temperature of ["cold", "warm"])
    await measureRun(variant, pair, workdir, temperature);
}

for (let pair = 1; pair <= pairs; pair++) {
  const offset = (pair - 1) % variants.length;
  const order = [...variants.slice(offset), ...variants.slice(0, offset)];
  for (const variant of order) await measure(variant, pair);
}
raw.finishedAt = new Date().toISOString();
save();
console.log(`Evidence: ${path.join(out, "raw.json")}`);
