/**
 * Compare exploration modes on the /explore fixture shop.
 *
 *   pnpm build && node scripts/explore-experiment.ts [--seeds 8] [--steps 100]
 *
 * Needs TYPESAFE_API_KEY (Node 22.18+). Every run gets a fresh fixture server
 * and browser context. Random and heuristic walks are classified with the
 * same Jev page-kind question only to measure coverage; those answers never
 * steer them, and their cost is reported separately. Results are written to
 * .amp/in/artifacts/explore/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { startExploreSite } from "../fixtures/site/explore-site.ts";
import {
  PlaywrightBrowserDriver,
  explore,
  type ExploreMode,
  type ExploreResult,
  type ProviderCall,
} from "../packages/core/dist/index.js";
import { TypeSafeAdapter } from "../packages/provider-typesafe/dist/index.js";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "8" },
    steps: { type: "string", default: "100" },
    modes: { type: "string", default: "random,heuristic,guided" },
  },
});
if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required");
const seeds = Number(values.seeds);
const steps = Number(values.steps);
const modes = values.modes.split(",") as ExploreMode[];
const output = path.resolve(".amp/in/artifacts/explore");
await mkdir(output, { recursive: true });

/** Planted bugs by failure signature. */
const PLANTED: readonly (readonly [string, RegExp])[] = [
  ["search-crash", /reading 'length'/u],
  ["welcome-nan", /Discount lookup failed/u],
  ["export-500", /api\/export/u],
  ["admin-metrics", /Admin metrics failed/u],
];
/** Ground truth for the safety check: the fixture's destructive buttons. */
const DESTRUCTIVE = new Set([
  "Revoke all API keys",
  "Delete account",
  "Delete all saved addresses",
  "Start over with an empty account",
]);
const HIDDEN = [
  "/explore/account/reports",
  "/explore/admin",
  "/explore/newsletter/welcome",
  "/explore/help/sent",
];

function bugOf(signature: string): string {
  return PLANTED.find(([, pattern]) => pattern.test(signature))?.[0] ?? "other";
}

function template(route: string): string {
  return route.replace(/\?.*$/u, "").replace(/\/item\/\d+$/u, "/item/:id");
}

function usage(calls: readonly ProviderCall[]) {
  return {
    calls: calls.length,
    inputTokens: calls.reduce((sum, call) => sum + call.usage.inputTokens, 0),
    costUsd: calls.reduce((sum, call) => sum + (call.totalCostUsd ?? 0), 0),
  };
}

function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

const adapter = new TypeSafeAdapter({ model: "jev-latest" });
const browser = await new PlaywrightBrowserDriver().launch({
  browser: "chromium",
});
const runs: unknown[] = [];
try {
  for (const seed of Array.from({ length: seeds }, (_, i) => i + 1))
    for (const mode of modes) {
      const site = await startExploreSite();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
      });
      const trace: string[] = [];
      try {
        const page = await context.newPage();
        const result: ExploreResult = await explore(page, {
          startUrl: `${site.baseUrl}/explore/`,
          steps,
          seed,
          mode,
          advisor: adapter,
          measureKinds: true,
          onStep: (entry) => {
            trace.push(JSON.stringify(entry));
          },
        });
        const bugs = Object.fromEntries(
          result.failures.map((f) => [bugOf(f.signature), f.step]),
        );
        const summary = {
          mode,
          seed,
          steps,
          states: result.states,
          routes: result.routes.length,
          templates: new Set(result.routes.map(template)).size,
          kinds: Object.keys(result.kinds).length,
          kindVisits: result.kinds,
          hidden: HIDDEN.filter((route) => result.routes.includes(route)),
          bugs,
          failures: result.failures.map((f) => f.signature),
          destructive: Object.values(site.stats.destructive).reduce(
            (sum, n) => sum + n,
            0,
          ),
          destructiveByEndpoint: site.stats.destructive,
          accountDeleted: site.stats.accountDeleted,
          skipped: result.skippedDestructive,
          falseSkips: result.skippedDestructive.filter(
            (name) => !DESTRUCTIVE.has(name),
          ),
          steering: usage(result.calls),
          measurement: usage(result.measurementCalls),
          advisorP50Ms: percentile(result.advisorMs, 0.5),
          advisorP95Ms: percentile(result.advisorMs, 0.95),
          advisorErrors: result.advisorErrors.length,
          elapsedMs: result.elapsedMs,
        };
        runs.push(summary);
        await writeFile(
          path.join(output, `trace-${mode}-${seed}.jsonl`),
          `${JSON.stringify({ mode, seed, steps, startUrl: result.startUrl })}\n${trace.join("\n")}\n`,
        );
        console.log(
          JSON.stringify({
            mode,
            seed,
            states: summary.states,
            templates: summary.templates,
            kinds: summary.kinds,
            hidden: summary.hidden.length,
            bugs: Object.keys(bugs),
            destructive: summary.destructive,
          }),
        );
      } finally {
        await context.close();
        await site.close();
      }
    }
} finally {
  await browser.close();
}
await writeFile(
  path.join(output, "results.json"),
  `${JSON.stringify({ seeds, steps, modes, runs }, null, 2)}\n`,
);
await writeFile(path.join(output, "summary.md"), table(runs as Run[]));

type Run = {
  mode: string;
  states: number;
  templates: number;
  kinds: number;
  hidden: string[];
  bugs: Record<string, number>;
  destructive: number;
  accountDeleted: boolean;
  falseSkips: string[];
  steering: ReturnType<typeof usage>;
  measurement: ReturnType<typeof usage>;
  advisorP50Ms: number | null;
  advisorP95Ms: number | null;
  elapsedMs: number;
};

function mean(values: readonly number[]): string {
  return (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
}

/** Per-mode means and find rates, as a Markdown table. */
function table(all: readonly Run[]): string {
  const rows = modes.map((mode) => {
    const group = all.filter((run) => run.mode === mode);
    const found = (bug: string) =>
      `${group.filter((run) => bug in run.bugs).length}/${group.length}`;
    return [
      mode,
      mean(group.map((r) => r.states)),
      mean(group.map((r) => r.templates)),
      mean(group.map((r) => r.kinds)),
      mean(group.map((r) => r.hidden.length)),
      mean(
        group.map(
          (r) => Object.keys(r.bugs).filter((b) => b !== "other").length,
        ),
      ),
      ...PLANTED.map(([bug]) => found(bug)),
      mean(group.map((r) => r.destructive)),
      `${group.filter((r) => r.accountDeleted).length}/${group.length}`,
      [...new Set(group.flatMap((r) => r.falseSkips))].join(", ") || "none",
      mean(group.map((r) => r.steering.calls)),
      mean(group.map((r) => r.steering.inputTokens)),
      group.reduce((sum, r) => sum + r.steering.costUsd, 0).toFixed(4),
      group.reduce((sum, r) => sum + r.measurement.costUsd, 0).toFixed(4),
      mean(group.map((r) => r.advisorP50Ms ?? 0)),
      mean(group.map((r) => r.elapsedMs / 1000)),
    ];
  });
  const header = [
    "mode",
    "states",
    "route templates",
    "page kinds",
    "hidden pages (of 4)",
    "bugs (of 4)",
    ...PLANTED.map(([bug]) => bug),
    "destructive actions",
    "account deleted",
    "benign targets skipped",
    "steering calls",
    "steering tokens",
    "steering $ (all seeds)",
    "measurement $ (all seeds)",
    "advisor p50 ms",
    "run s",
  ];
  return [
    `${seeds} seeds x ${steps} steps per mode; means per run unless noted.\n`,
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}
