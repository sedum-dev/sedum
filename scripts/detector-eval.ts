/**
 * Bug-detector evaluation on the labelled fixture pages; paid calls when
 * semantic. Usage: bun scripts/detector-eval.ts [--offline] [--repeat N] [--real]
 *
 * One live run records raw Jev answers per page state. Thresholds are swept
 * offline on the dev split and reported on the held-out split.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startFixtureSite } from "../fixtures/site/server.ts";
import {
  DETECTOR_ALLOW,
  DETECTOR_CASES,
  type DetectorCase,
  type DetectorLabel,
} from "../fixtures/site/detector-pages.ts";
import {
  BugDetector,
  DEFAULT_SEMANTIC_THRESHOLDS,
  PlaywrightBrowserDriver,
  executeStep,
  RuntimeUrl,
  type BrowserPage,
  type StepInspection,
} from "../packages/core/dist/index.js";
import { TypeSafeAdapter } from "../packages/provider-typesafe/dist/index.js";

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const repeatAt = args.indexOf("--repeat");
const repeat = repeatAt >= 0 ? Number(args[repeatAt + 1]) : 1;
if (!Number.isInteger(repeat) || repeat < 1)
  throw new Error("--repeat takes a positive integer");
const real = args.includes("--real");
const artifacts = path.resolve(".amp/in/artifacts/detector");

const SEMANTIC = [
  "error_message",
  "stuck_loading",
  "empty_content",
  "broken_value",
] as const;
type Semantic = (typeof SEMANTIC)[number];
const BROWSER = [
  "console_error",
  "uncaught_exception",
  "unhandled_rejection",
  "http_error",
] as const;
const CHECKS: readonly DetectorLabel[] = [...BROWSER, ...SEMANTIC];
/** The loop waits on anything this loading-like, so stuck can be swept down to it. */
const LOOP_STUCK = 0.2;

interface StepRecord {
  readonly caseId: string;
  readonly split: DetectorCase["split"];
  readonly step: "load" | "action";
  readonly expect: readonly DetectorLabel[];
  readonly tolerate: readonly DetectorLabel[];
  /** Browser and exact-text detections, independent of thresholds. */
  readonly fixed: readonly DetectorLabel[];
  /** Final state's model answer and its wait outcome. */
  readonly model: {
    readonly probabilities: Record<Semantic, number>;
    readonly severity: number;
    readonly severityConfidence: number;
    readonly waited: "changed" | "unchanged" | null;
  } | null;
  readonly detectorMs: number;
  readonly calls: number;
  readonly cachedStates: number;
  readonly messages: readonly string[];
}

interface CallRecord {
  readonly inputTokens: number;
  readonly costUsd: number | null;
  readonly apiMs: number;
}

function stepRecord(
  item: DetectorCase,
  step: "load" | "action",
  found: StepInspection,
  detectorMs: number,
): StepRecord {
  const last = found.inspections.at(-1);
  return {
    caseId: item.id,
    split: item.split,
    step,
    expect: (step === "load" ? item.expect.load : item.expect.action) ?? [],
    tolerate: item.tolerate ?? [],
    fixed: [
      ...new Set(
        found.detections
          .filter((d) => d.source !== "model")
          .map((d) => d.check as DetectorLabel),
      ),
    ],
    model: last
      ? {
          probabilities: { ...last.inspection.probabilities },
          severity: last.inspection.severity.score,
          severityConfidence: last.inspection.severity.confidence,
          waited: last.waited,
        }
      : null,
    detectorMs,
    calls: found.calls.length,
    cachedStates: found.inspections.filter((i) => i.cached).length,
    messages: found.detections.map(
      (d) =>
        `${d.check}/${d.source ?? "browser"}${d.probability === undefined ? "" : ` p=${d.probability.toFixed(2)}`}: ${d.message}`,
    ),
  };
}

async function inspect(
  detector: BugDetector,
  page: BrowserPage,
  calls: CallRecord[],
) {
  const started = performance.now();
  const found = await detector.inspectStep(page);
  for (const { call, apiMs } of found.calls)
    calls.push({
      inputTokens: call.usage.inputTokens,
      costUsd: call.totalCostUsd,
      apiMs,
    });
  return { found, ms: performance.now() - started };
}

type Session = Awaited<ReturnType<PlaywrightBrowserDriver["launch"]>>;

async function runCases(
  browser: Session,
  baseUrl: string,
  detector: BugDetector,
) {
  const steps: StepRecord[] = [];
  const calls: CallRecord[] = [];
  try {
    for (const item of DETECTOR_CASES) {
      const context = await browser.newContext({ collectSignals: true });
      const page = await context.newPage();
      await executeStep(page, {
        op: "goto",
        url: new RuntimeUrl([`${baseUrl}/detector/${item.id}`]),
      });
      const load = await inspect(detector, page, calls);
      steps.push(stepRecord(item, "load", load.found, load.ms));
      if (item.expect.action) {
        await page.playwright!().page.click("#act");
        const action = await inspect(detector, page, calls);
        steps.push(stepRecord(item, "action", action.found, action.ms));
      }
      await context.close();
      process.stderr.write(`${item.id} `);
    }
  } finally {
    process.stderr.write("\n");
  }
  return { steps, calls };
}

interface Thresholds {
  readonly error_message: number;
  readonly stuck_loading: number;
  readonly empty_content: number;
  readonly broken_value: number;
  readonly minSeverity: number;
}

/** Whether the model's answer raises one check, as the detector decides it. */
function modelRaises(
  step: StepRecord,
  model: NonNullable<StepRecord["model"]>,
  check: Semantic,
  t: Thresholds,
): boolean {
  return [
    model.probabilities[check] >= t[check],
    // An exact leak already covers broken_value.
    check !== "broken_value" || !step.fixed.includes("broken_value"),
    check !== "stuck_loading" || model.waited === "unchanged",
  ].every(Boolean);
}

/** Recompute a step's detections at the given thresholds, as the detector would. */
function predicted(step: StepRecord, t: Thresholds): Set<DetectorLabel> {
  const out = new Set<DetectorLabel>(step.fixed);
  const model = step.model;
  if (!model || model.severity < t.minSeverity) return out;
  for (const check of SEMANTIC)
    if (modelRaises(step, model, check, t)) out.add(check);
  return out;
}

interface Score {
  tp: number;
  fp: number;
  fn: number;
}

function score(
  steps: readonly StepRecord[],
  t: Thresholds,
  check: DetectorLabel,
  source?: "fixed" | "model",
): Score {
  const result = { tp: 0, fp: 0, fn: 0 };
  for (const step of steps) {
    const all = predicted(step, t);
    const hit =
      source === "fixed"
        ? step.fixed.includes(check)
        : source === "model"
          ? all.has(check) && !step.fixed.includes(check)
          : all.has(check);
    const expected = step.expect.includes(check);
    if (hit && expected) result.tp++;
    else if (hit && !step.tolerate.includes(check)) result.fp++;
    else if (!hit && expected) result.fn++;
  }
  return result;
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const pr = (s: Score) => ({
  precision: ratio(s.tp, s.tp + s.fp),
  recall: ratio(s.tp, s.tp + s.fn),
  f1: ratio(2 * s.tp, 2 * s.tp + s.fp + s.fn),
});
const fmt = (value: number | null) => (value === null ? "–" : value.toFixed(2));

const GRID = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);

/**
 * Max F1 on dev. Several thresholds usually tie; the middle of that plateau
 * leaves the most margin on both sides for unseen pages.
 */
function tune(steps: readonly StepRecord[], base: Thresholds): Thresholds {
  let tuned = { ...base };
  for (const check of SEMANTIC) {
    const grid = GRID.filter(
      (t) => check !== "stuck_loading" || t >= LOOP_STUCK,
    );
    const f1s = grid.map(
      (t) => pr(score(steps, { ...tuned, [check]: t }, check)).f1 ?? 0,
    );
    const best = Math.max(...f1s);
    const plateau = grid.filter((_, index) => f1s[index]! >= best - 1e-9);
    tuned = {
      ...tuned,
      [check]: plateau[Math.floor((plateau.length - 1) / 2)]!,
    };
  }
  return tuned;
}

function table(
  title: string,
  steps: readonly StepRecord[],
  t: Thresholds,
): string[] {
  const lines = [
    `### ${title}`,
    "",
    "| check | TP | FP | FN | precision | recall | F1 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const check of CHECKS) {
    const s = score(steps, t, check);
    const m = pr(s);
    lines.push(
      `| ${check} | ${s.tp} | ${s.fp} | ${s.fn} | ${fmt(m.precision)} | ${fmt(m.recall)} | ${fmt(m.f1)} |`,
    );
  }
  const all = CHECKS.map((check) => score(steps, t, check)).reduce((a, b) => ({
    tp: a.tp + b.tp,
    fp: a.fp + b.fp,
    fn: a.fn + b.fn,
  }));
  const m = pr(all);
  lines.push(
    `| **all** | ${all.tp} | ${all.fp} | ${all.fn} | ${fmt(m.precision)} | ${fmt(m.recall)} | ${fmt(m.f1)} |`,
  );
  const cleanSteps = steps.filter((s) => s.expect.length === 0);
  const flaggedClean = cleanSteps.filter((s) =>
    [...predicted(s, t)].some((c) => !s.tolerate.includes(c)),
  ).length;
  lines.push(
    "",
    `Clean steps flagged: ${flaggedClean}/${cleanSteps.length}. Buggy steps with at least one expected check found: ${
      steps.filter(
        (s) => s.expect.length && s.expect.some((c) => predicted(s, t).has(c)),
      ).length
    }/${steps.filter((s) => s.expect.length).length}.`,
    "",
  );
  return lines;
}

function brokenValueSplit(steps: readonly StepRecord[], t: Thresholds) {
  const fixed = pr(score(steps, t, "broken_value", "fixed"));
  const model = score(steps, t, "broken_value", "model");
  return `broken_value by source: exact strings precision ${fmt(fixed.precision)} recall ${fmt(fixed.recall)}; Jev adds ${model.tp} hits and ${model.fp} false positives.`;
}

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function costLines(runs: readonly Awaited<ReturnType<typeof runCases>>[]) {
  const calls = runs.flatMap((run) => run.calls);
  const steps = runs.flatMap((run) => run.steps);
  const tokens = calls.reduce((sum, call) => sum + call.inputTokens, 0);
  const cost = calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  const api = calls.map((call) => call.apiMs);
  const detector = steps.map((step) => step.detectorMs);
  return [
    "### Cost and latency",
    "",
    `- Steps: ${steps.length} across ${runs.length} run(s); model calls ${calls.length}; cached states ${steps.reduce((sum, step) => sum + step.cachedStates, 0)}.`,
    `- Input tokens ${tokens} (mean ${calls.length ? Math.round(tokens / calls.length) : 0} per call); output tokens are free.`,
    `- Cost $${cost.toFixed(6)} (mean $${calls.length ? (cost / calls.length).toFixed(7) : 0} per call).`,
    `- Jev call latency p50 ${percentile(api, 0.5).toFixed(0)} ms, p90 ${percentile(api, 0.9).toFixed(0)} ms, max ${Math.max(0, ...api).toFixed(0)} ms.`,
    `- Detector time per step p50 ${percentile(detector, 0.5).toFixed(0)} ms, p90 ${percentile(detector, 0.9).toFixed(0)} ms (includes network settle and the stuck-loading wait).`,
    "",
  ];
}

function stability(runs: readonly Awaited<ReturnType<typeof runCases>>[]) {
  if (runs.length < 2) return [];
  let maxDelta = 0;
  let flips = 0;
  const first = runs[0]!.steps;
  for (const run of runs.slice(1))
    run.steps.forEach((step, index) => {
      const a = first[index]!.model;
      const b = step.model;
      if (!a || !b) return;
      for (const check of SEMANTIC) {
        maxDelta = Math.max(
          maxDelta,
          Math.abs(a.probabilities[check] - b.probabilities[check]),
        );
        if (a.probabilities[check] >= 0.5 !== b.probabilities[check] >= 0.5)
          flips++;
      }
    });
  return [
    `Stability over ${runs.length} fresh runs: max probability change ${maxDelta.toFixed(3)}, decisions flipped at 0.5: ${flips}.`,
    "",
  ];
}

function rawTable(steps: readonly StepRecord[]): string[] {
  const lines = [
    "### Raw answers (first run)",
    "",
    "| case | split | step | expected | fixed | error | stuck | empty | broken | severity (conf) | waited |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of steps) {
    const m = s.model;
    lines.push(
      `| ${s.caseId} | ${s.split} | ${s.step} | ${s.expect.join(", ") || "clean"} | ${s.fixed.join(", ")} | ${m ? SEMANTIC.map((c) => m.probabilities[c].toFixed(2)).join(" | ") : "– | – | – | –"} | ${m ? `${m.severity.toFixed(2)} (${m.severityConfidence.toFixed(2)})` : "–"} | ${m?.waited ?? ""} |`,
    );
  }
  return [...lines, ""];
}

const REAL_SITES = [
  "https://example.com/",
  "https://en.wikipedia.org/wiki/Software_bug",
  "https://docs.python.org/3/tutorial/errors.html",
  "https://news.ycombinator.com/",
  "https://the-internet.herokuapp.com/",
  "https://www.saucedemo.com/",
  "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof",
  "https://github.com/antithesishq/bombadil",
];

async function realSites(
  browser: Session,
  detector: BugDetector,
  calls: CallRecord[],
) {
  const lines = [
    "### Unlabelled public pages",
    "",
    "| page | detections |",
    "|---|---|",
  ];
  try {
    for (const url of REAL_SITES) {
      const context = await browser.newContext({ collectSignals: true });
      const page = await context.newPage();
      try {
        await executeStep(page, { op: "goto", url: new RuntimeUrl([url]) });
        const { found } = await inspect(detector, page, calls);
        const last = found.inspections.at(-1)?.inspection;
        const raw = last
          ? ` (p: ${SEMANTIC.map((c) => `${c.split("_")[0]} ${last.probabilities[c].toFixed(2)}`).join(", ")}; sev ${last.severity.score.toFixed(2)})`
          : "";
        lines.push(
          `| ${url} | ${found.detections.map((d) => `${d.check}/${d.source ?? "browser"}: ${d.message.replace(/\|/gu, "/").slice(0, 120)}`).join("<br>") || "none"}${raw} |`,
        );
      } catch (error) {
        lines.push(
          `| ${url} | could not load: ${String(error).slice(0, 80)} |`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    process.stderr.write("\n");
  }
  return [...lines, ""];
}

const DEFAULT: Thresholds = {
  error_message: 0.5,
  stuck_loading: 0.5,
  empty_content: 0.5,
  broken_value: 0.5,
  minSeverity: 0,
};
const SHIPPED: Thresholds = DEFAULT_SEMANTIC_THRESHOLDS;

const site = await startFixtureSite();
// Bun loses the browser pipe after a relaunch, so every run shares one browser.
const browser = await new PlaywrightBrowserDriver().launch({
  browser: "chromium",
});
try {
  const inspector = offline ? null : new TypeSafeAdapter();
  const newDetector = () =>
    new BugDetector({
      allow: DETECTOR_ALLOW,
      ...(inspector
        ? {
            semantic: {
              inspector,
              thresholds: { stuck_loading: LOOP_STUCK },
            },
          }
        : {}),
    });
  const runs: Awaited<ReturnType<typeof runCases>>[] = [];
  for (let index = 0; index < repeat; index++)
    runs.push(await runCases(browser, site.baseUrl, newDetector()));
  const steps = runs[0]!.steps;
  const dev = steps.filter((s) => s.split === "dev");
  const heldout = steps.filter((s) => s.split === "heldout");
  const tuned = offline ? DEFAULT : tune(dev, DEFAULT);
  const severityGate = offline
    ? null
    : [0.5, 1, 1.5].map((minSeverity) => {
        const t = { ...tuned, minSeverity };
        const m = pr(
          SEMANTIC.map((c) => score(dev, t, c)).reduce((a, b) => ({
            tp: a.tp + b.tp,
            fp: a.fp + b.fp,
            fn: a.fn + b.fn,
          })),
        );
        return `minSeverity ${minSeverity}: dev semantic precision ${fmt(m.precision)} recall ${fmt(m.recall)}`;
      });
  const realCalls: CallRecord[] = [];
  const realLines = real
    ? await realSites(
        browser,
        new BugDetector({
          ...(inspector ? { semantic: { inspector } } : {}),
        }),
        realCalls,
      )
    : [];
  const lines = [
    `## Bug detector evaluation (${offline ? "offline: browser checks only" : "live Jev"})`,
    "",
    `Cases: ${DETECTOR_CASES.length} (${DETECTOR_CASES.filter((c) => c.split === "dev").length} dev, ${DETECTOR_CASES.filter((c) => c.split === "heldout").length} held-out); steps: ${steps.length}.`,
    "",
    `Thresholds tuned on dev: ${SEMANTIC.map((c) => `${c} ${tuned[c]}`).join(", ")}.`,
    "",
    ...table("Dev split, tuned thresholds", dev, tuned),
    ...table("Held-out split, tuned thresholds", heldout, tuned),
    ...table("Held-out split, all thresholds 0.5", heldout, DEFAULT),
    `Shipped defaults: ${SEMANTIC.map((c) => `${c} ${SHIPPED[c]}`).join(", ")}.`,
    "",
    ...table("Held-out split, shipped defaults", heldout, SHIPPED),
    ...table("All cases, shipped defaults", steps, SHIPPED),
    brokenValueSplit(steps, SHIPPED),
    "",
    ...(severityGate
      ? ["Severity gate on dev:", ...severityGate.map((l) => `- ${l}`), ""]
      : []),
    ...stability(runs),
    ...costLines(runs),
    ...(realCalls.length
      ? [
          `Public pages: ${realCalls.length} calls, ${realCalls.reduce((s, c) => s + c.inputTokens, 0)} input tokens, $${realCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0).toFixed(6)}.`,
          "",
        ]
      : []),
    ...realLines,
    ...rawTable(steps),
  ];
  const report = lines.join("\n");
  console.log(report);
  await mkdir(artifacts, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  await writeFile(
    path.join(artifacts, `eval-${offline ? "offline" : "live"}-${stamp}.md`),
    report,
  );
  await writeFile(
    path.join(artifacts, `eval-${offline ? "offline" : "live"}-${stamp}.json`),
    JSON.stringify({ tuned, runs }, null, 2),
  );
} finally {
  await browser.close();
  await site.close().catch(() => undefined);
}
