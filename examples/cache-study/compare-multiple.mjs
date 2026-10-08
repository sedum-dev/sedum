import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import console from "node:console";
import { fileURLToPath } from "node:url";

const source = path.dirname(fileURLToPath(import.meta.url));
const [
  stock,
  candidate,
  destination,
  pairs = "5",
  selection = "sentences,catalog,queue,settings",
] = process.argv.slice(2);
if (!stock || !candidate || !destination)
  throw new Error(
    "Usage: compare-multiple.mjs STOCK CANDIDATE NEW_OUTPUT [PAIRS] [WORKLOADS]",
  );
const out = path.resolve(destination);
mkdirSync(out); // Never mix previous evidence with a new cohort.
const variants = {
  stock: path.resolve(stock),
  candidate: path.resolve(candidate),
};
const workloads = selection.split(",");
const expectedActions = { sentences: 12, catalog: 2, queue: 2, settings: 4 };
if (workloads.some((name) => !Object.hasOwn(expectedActions, name)))
  throw new Error("Unknown benchmark workload");
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const provenance = {
  baseline: "3d4eb13e184fc244a71aba3de35447db21d2382d",
  pairs: Number(pairs),
  sourceHashes: Object.fromEntries(
    workloads.map((name) => [
      name,
      hash(path.join(source, "tests", `${name}.test.ts`)),
    ]),
  ),
  matcherHashes: Object.fromEntries(
    Object.entries(variants).map(([name, dir]) => [
      name,
      hash(path.join(dir, "packages/core/src/page-cache.ts")),
    ]),
  ),
  fixtureHash: hash(path.join(source, "local-fixture.mjs")),
};
const runs = [];

function project(variant, workload, pair) {
  const cwd = path.join(out, `${variant}-${workload}-${pair}`);
  mkdirSync(cwd);
  mkdirSync(path.join(cwd, "node_modules"));
  symlinkSync(
    path.join(variants[variant], "packages/cli"),
    path.join(cwd, "node_modules/sedum-cli"),
  );
  cpSync(path.join(source, "tests"), path.join(cwd, "tests"), {
    recursive: true,
  });
  const url =
    workload === "sentences"
      ? "https://www.saucedemo.com"
      : "http://127.0.0.1:23600";
  writeFileSync(
    path.join(cwd, "sedum.config.yaml"),
    `baseUrl: ${url}\ntests:\n  directory: tests\nbrowser: chromium\nviewport: { width: 1280, height: 900 }\nprovider:\n  name: typesafe\n  model: jev-1.13.0\n`,
  );
  if (spawnSync("git", ["init", "-q"], { cwd }).status !== 0)
    throw new Error("Fixture Git initialization failed");
  return cwd;
}

function resultFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return resultFiles(file);
    return entry.name === "result.json" ? [file] : [];
  });
}

function billing(report, calls) {
  const tokenCost = calls.reduce(
    (sum, call) =>
      sum +
      (call.inputTokens * call.inputUsdPerMillion +
        call.outputTokens * call.outputUsdPerMillion) /
        1e6,
    0,
  );
  const verifiedCost =
    report.totals.costComplete &&
    calls.every(
      (call) =>
        Number.isFinite(call.inputUsdPerMillion) &&
        Number.isFinite(call.outputUsdPerMillion),
    ) &&
    Math.abs(tokenCost - report.totals.costUsd) < 1e-12 &&
    calls.length === report.totals.modelCalls;
  return { tokenCostUsd: tokenCost, verifiedCost };
}

function timeline(report) {
  const attempts = report.tests.flatMap((test) => test.attempts);
  const steps = attempts.flatMap((attempt) => attempt.steps);
  const calls = [
    ...report.setupCalls,
    ...attempts.flatMap((attempt) => [
      ...(attempt.calls ?? []),
      ...attempt.steps.flatMap((step) => step.calls),
    ]),
  ];
  return { attempts, steps, calls };
}

function diagnostics(steps) {
  const actions = steps.filter((step) =>
    ["click", "type"].includes(step.operation),
  );
  const assertions = steps.filter((step) => step.kind === "verify");
  return {
    hits: actions.filter((step) => step.locator?.cache?.outcome === "hit")
      .length,
    actions: actions.map((step) => ({
      sentence: step.sentence,
      operation: step.operation,
      cache: step.locator?.cache,
      confidence: step.locator?.confidence,
      calls: step.calls.length,
    })),
    assertions: assertions.map((step) => ({
      sentence: step.sentence,
      verdict: step.verdict,
      calls: step.calls.length,
    })),
  };
}

function accounting(report) {
  const { attempts, steps, calls } = timeline(report);
  return {
    executed: report.totals.executedTests > 0,
    passed: report.totals.passedTests === 1 && report.totals.failedTests === 0,
    elapsedMs: attempts[0]?.elapsedMs,
    calls: calls.length,
    inputTokens: report.totals.inputTokens,
    outputTokens: report.totals.outputTokens,
    costUsd: report.totals.costUsd,
    ...billing(report, calls),
    ...diagnostics(steps),
    providerCalls: calls,
  };
}

function invoke(variant, workload, temperature, cwd) {
  const args = [
    path.join(variants[variant], "packages/cli/dist/cli.js"),
    "run",
    `tests/${workload}.test.ts`,
    "--parallel",
    "1",
    "--retries",
    "0",
    "--locator-cache-ci",
    "--output-dir",
    `.sedum/${temperature}`,
    "--reporter-dir",
    `.sedum/${temperature}`,
    "--reporter",
    "json",
    "--costs",
  ];
  const env = {
    ...process.env,
    CACHE_DISPLAY: temperature === "cold" ? "Ada" : "Grace",
    CACHE_PASSWORD:
      temperature === "cold" ? "local-password-old" : "local-password-new",
  };
  delete env.SEDUM_GOAL_REPLAY_DIR;
  delete env.SEDUM_GOAL_REPLAY_MATCH;
  const started = performance.now();
  const child = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 180_000,
  });
  const wallMs = performance.now() - started;
  return { child, wallMs, args };
}

function readResults(cwd, temperature) {
  let files = [];
  try {
    files = resultFiles(path.join(cwd, ".sedum", temperature));
  } catch {
    /* Infrastructure evidence stays available. */
  }
  const report =
    files.length === 1 ? JSON.parse(readFileSync(files[0], "utf8")) : null;
  return { files, report };
}

function validMetrics(metrics, workload) {
  if (metrics.actions.length !== expectedActions[workload]) return false;
  if (metrics.assertions.length !== 2) return false;
  if (metrics.assertions.some((step) => step.calls !== 1)) return false;
  return metrics.verifiedCost;
}

function execute({ variant, workload, pair, temperature, cwd }) {
  const id = `${variant}-${workload}-${pair}-${temperature}`;
  const { child, wallMs, args } = invoke(variant, workload, temperature, cwd);
  writeFileSync(path.join(out, `${id}.stdout.txt`), child.stdout ?? "");
  writeFileSync(path.join(out, `${id}.stderr.txt`), child.stderr ?? "");
  const { files, report } = readResults(cwd, temperature);
  const metrics = report
    ? accounting(report)
    : { executed: false, passed: false };
  const run = {
    id,
    variant,
    workload,
    pair,
    temperature,
    exitCode: child.status,
    signal: child.signal,
    error: child.error?.message,
    wallMs,
    command: [process.execPath, ...args],
    cwd,
    resultFiles: files,
    ...metrics,
  };
  runs.push(run);
  writeFileSync(
    path.join(out, "raw.json"),
    JSON.stringify({ provenance, runs }, null, 2),
  );
  console.log(
    id,
    child.status,
    Math.round(wallMs),
    metrics.calls,
    metrics.hits,
    metrics.costUsd,
  );
  if (metrics.passed && !validMetrics(metrics, workload))
    throw new Error(`Evidence contract failed: ${id}`);
  if (!metrics.executed)
    throw new Error(`Infrastructure failure: ${id}; evidence retained`);
}

for (let pair = 1; pair <= Number(pairs); pair++) {
  for (const workload of workloads) {
    const order = pair % 2 ? ["stock", "candidate"] : ["candidate", "stock"];
    for (const variant of order) {
      const cwd = project(variant, workload, pair);
      for (const temperature of ["cold", "warm"])
        execute({ variant, workload, pair, temperature, cwd });
    }
  }
}
if (runs.some((run) => run.exitCode !== 0 || !run.passed)) process.exitCode = 1;
