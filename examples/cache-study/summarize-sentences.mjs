import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const root = path.resolve("../..");
const out = path.resolve(
  process.env.CACHE_STUDY_OUTPUT ??
    path.join(root, ".amp/in/artifacts/sentence-cache"),
);
const read = (name) => JSON.parse(readFileSync(path.join(out, name), "utf8"));
function reconcileAccounting(report, calls, id) {
  const tokenCost = calls.reduce(
    (sum, call) =>
      sum +
      (call.inputTokens * call.inputUsdPerMillion +
        call.outputTokens * call.outputUsdPerMillion) /
        1e6,
    0,
  );
  if (!report.totals.costComplete) throw new Error(`Incomplete cost: ${id}`);
  if (Math.abs(tokenCost - report.totals.costUsd) > 1e-12)
    throw new Error(`Unreconciled cost: ${id}`);
  if (calls.length !== report.totals.modelCalls)
    throw new Error(`Unreconciled calls: ${id}`);
  return tokenCost;
}
function verifyCoverage(actions, assertions, id) {
  if (actions.length !== 12) throw new Error(`Changed action coverage: ${id}`);
  if (assertions.length !== 2)
    throw new Error(`Changed assertion coverage: ${id}`);
  if (assertions.some((step) => step.calls.length !== 1))
    throw new Error(`Assertions not live: ${id}`);
}
function project(run) {
  const report = run.report;
  if (!report)
    return {
      id: run.id,
      executed: false,
      exitCode: run.exitCode,
      wallMs: run.wallMs,
    };
  const attempts = report.tests.flatMap((test) => test.attempts);
  const steps = attempts.flatMap((attempt) => attempt.steps);
  const calls = [
    ...report.setupCalls,
    ...attempts.flatMap((attempt) => [
      ...(attempt.calls ?? []),
      ...attempt.steps.flatMap((step) => step.calls),
    ]),
  ];
  const actions = steps.filter((step) =>
    ["click", "type"].includes(step.operation),
  );
  const assertions = steps.filter((step) => step.kind === "verify");
  const tokenCost = reconcileAccounting(report, calls, run.id);
  verifyCoverage(actions, assertions, run.id);
  return {
    id: run.id,
    track: run.track,
    pair: run.pair,
    temperature: run.temperature,
    executed: true,
    passed: run.exitCode === 0 && report.totals.passedTests === 1,
    elapsedMs: attempts[0].elapsedMs,
    runElapsedMs: report.elapsedMs,
    wallMs: run.wallMs,
    calls: calls.length,
    inputTokens: report.totals.inputTokens,
    outputTokens: report.totals.outputTokens,
    costUsd: report.totals.costUsd,
    tokenCostUsd: tokenCost,
    hits: actions.filter((step) => step.locator?.cache?.outcome === "hit")
      .length,
    actions: actions.map((step) => ({
      sentence: step.sentence,
      operation: step.operation,
      cache: step.locator?.cache,
      confidence: step.locator?.confidence,
      source: step.locator?.source,
      calls: step.calls.length,
    })),
    assertions: assertions.map((step) => ({
      sentence: step.sentence,
      verdict: step.verdict,
      calls: step.calls.length,
    })),
    providerCalls: calls,
    command: run.command,
  };
}
const runs = ["baseline", "poc"].flatMap((track) =>
  read(`${track}-raw.json`).runs.map(project),
);
const groups = [];
for (const track of ["baseline", "poc"])
  for (const temperature of ["cold", "warm"]) {
    const selected = runs.filter(
      (run) =>
        run.track === track && run.temperature === temperature && run.executed,
    );
    const means = Object.fromEntries(
      [
        "elapsedMs",
        "wallMs",
        "calls",
        "inputTokens",
        "outputTokens",
        "costUsd",
        "hits",
      ].map((field) => [
        field,
        selected.reduce((sum, run) => sum + run[field], 0) / selected.length,
      ]),
    );
    groups.push({
      track,
      temperature,
      attempts: selected.length,
      passed: selected.filter((run) => run.passed).length,
      ...means,
    });
  }
const sources = Object.fromEntries(
  [
    "packages/core/src/page-cache.ts",
    "examples/cache-study/tests/sentences.test.ts",
    "examples/cache-study/tests/support/saucedemo.ts",
  ].map((file) => [
    file,
    createHash("sha256")
      .update(readFileSync(path.join(root, file)))
      .digest("hex"),
  ]),
);
const rates = [
  ...new Set(
    runs.flatMap((run) =>
      (run.providerCalls ?? []).map((call) =>
        JSON.stringify({
          model: call.model,
          inputUsdPerMillion: call.inputUsdPerMillion,
          outputUsdPerMillion: call.outputUsdPerMillion,
          rateSource: call.rateSource,
          rateCheckedAt: call.rateCheckedAt,
        }),
      ),
    ),
  ),
].map((value) => JSON.parse(value));
const summary = {
  experiment:
    "Sentence-action locator cache; no goal replay or effect contracts",
  baselineRevision: "3d4eb13e184fc244a71aba3de35447db21d2382d",
  method:
    "Three independent fresh-cache cold/warm pairs per stock/POC, serial CLI processes/fresh contexts, Chromium 1280x900, zero retries; original sources/values and deterministic plus two live Jev assertions retained.",
  caveats:
    "Public-site/provider variation; n=3 and serial stock then POC. Cold overhead is observed end-to-end difference, not isolated recording CPU cost. Provider-side caching was not reset. Earlier POC cohorts retained in pre-final, excluded from final means; second earlier export mixed old/new result selection and is not used.",
  sources,
  rates,
  groups,
  runs,
};
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(groups, null, 2));
