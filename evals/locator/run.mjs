import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import process from "node:process";
import console from "node:console";
import {
  PlaywrightBrowserDriver,
  quietPage,
  resolveTarget,
} from "../../packages/core/dist/index.js";
import { loadRealSuites, loadSuites } from "./lib/cases.mjs";
import { storeDir } from "./real/lib/browser.mjs";
import { DEEP_QUERY } from "./real/lib/inventory.mjs";
import { serveStore } from "./real/lib/serve.mjs";
import { cachedResolver, lexicalResolver } from "./lib/resolvers.mjs";
import { scoreCase, summarize } from "./lib/score.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const realRoot = join(root, "real");
const { values: args } = parseArgs({
  options: {
    resolver: { type: "string", default: "lexical" },
    case: { type: "string" },
    tag: { type: "string" },
    variant: { type: "string" },
    offline: { type: "boolean", default: false },
    verbose: { type: "boolean", short: "v", default: false },
    out: { type: "string" },
    validate: { type: "boolean", default: false },
    suite: { type: "string", default: "synthetic" },
    site: { type: "string" },
    // Experimental repeated-member policy: --trust 0.7,0.3 --same-destination
    trust: { type: "string" },
    "same-destination": { type: "boolean", default: false },
    "duplicate-links": { type: "boolean", default: false },
  },
});

function repeatedMemberPolicy() {
  const policy = {};
  if (args["same-destination"]) policy.sameDestination = true;
  if (args["duplicate-links"]) policy.duplicateLinks = true;
  if (args.trust) {
    const [minProbability, minLead] = args.trust.split(",").map(Number);
    if (!(minProbability >= 0 && minLead >= 0))
      throw new Error("--trust takes <minProbability>,<minLead>, e.g. 0.7,0.3");
    policy.trust = { minProbability, minLead };
  }
  return Object.keys(policy).length ? policy : undefined;
}
const repeatedMember = repeatedMemberPolicy();

const real = args.suite === "real";
if (!real && args.suite !== "synthetic")
  throw new Error(`Unknown suite ${args.suite}; use synthetic or real.`);
const store = storeDir(realRoot);

function loadCases() {
  const {
    cases,
    problems,
    missing = [],
  } = real ? loadRealSuites(realRoot, store) : loadSuites(root);
  if (missing.length)
    console.error(
      `Skipping ${missing.length} site(s) with no snapshot in ${store}: ${missing.join(", ")}`,
    );
  if (problems.length) {
    console.error(["Invalid eval cases:", ...problems].join("\n  "));
    process.exit(1);
  }
  return cases.filter(
    (testCase) =>
      (!args.case || testCase.id.includes(args.case)) &&
      (!args.tag || testCase.tags?.includes(args.tag)) &&
      (!args.variant || testCase.variant === args.variant) &&
      (!args.site || testCase.site === args.site),
  );
}

async function makeResolver() {
  if (args.resolver === "lexical") return { resolver: lexicalResolver() };
  if (args.resolver === "typesafe") {
    const { TypeSafeAdapter } =
      await import("../../packages/provider-typesafe/dist/index.js");
    const model = process.env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest";
    const inner = args.offline
      ? { choose: () => Promise.reject(new Error("offline")) }
      : new TypeSafeAdapter();
    const cache = cachedResolver(
      inner,
      // Real-site replies quote page text, so they stay in the store.
      join(
        real ? join(store, "replies") : join(root, "replies"),
        `${model}.json`,
      ),
      { model, offline: args.offline },
    );
    return { resolver: cache, cache };
  }
  throw new Error(
    `Unknown resolver ${args.resolver}; use lexical or typesafe.`,
  );
}

function serve(dir) {
  const server = createServer((request, response) => {
    const path = normalize(
      decodeURIComponent(new URL(request.url, "http://x").pathname),
    );
    const file = resolve(dir, "." + path);
    if (!file.startsWith(dir + "/") || !file.endsWith(".html")) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((ready) =>
    server.listen(0, "127.0.0.1", () =>
      ready({ server, base: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

/** Map run-local candidate refs to their `data-eval-gold` labels. */
function goldOf(page, refs) {
  return page.evaluate(
    `((refs) => {
      const find = (root, selector) => {
        const hit = root.querySelector(selector);
        if (hit) return hit;
        for (const el of root.querySelectorAll("*"))
          if (el.shadowRoot) { const inner = find(el.shadowRoot, selector); if (inner) return inner; }
        return null;
      };
      return refs.map((ref) => {
        const element = find(document, '[data-sedum-ref="' + CSS.escape(ref) + '"]');
        return element ? element.getAttribute("data-eval-gold") : null;
      });
    })(${JSON.stringify(refs)})`,
  );
}

/** Label a real snapshot's targets in the page; returns the first failure. */
async function markTargets(page, targets) {
  return page.evaluate(
    `((targets) => {
      const query = ${DEEP_QUERY};
      for (const [id, chain] of Object.entries(targets)) {
        const found = query(chain);
        if (found.error) return id + ": selector " + found.error;
        found.element.setAttribute("data-eval-gold", id);
      }
      return null;
    })(${JSON.stringify(targets)})`,
  );
}

/** Record each model decision with the gold label of every offered option. */
function recording(inner, page, decisions) {
  return {
    async choose(sentence, candidates, options) {
      const offered = candidates.options.filter(
        (option) => option.kind === "candidate",
      );
      // Labels are read while this scan's refs are still on the page.
      const golds = await goldOf(
        page,
        offered.map((option) => option.candidate.id),
      );
      const decision = await inner.choose(sentence, candidates, options);
      decisions.push({
        options: offered.map((option, index) => ({
          id: option.candidate.id,
          gold: golds[index],
          tag: option.candidate.tag,
          role: option.candidate.role,
          name: option.candidate.name,
          peers: option.candidate.peers,
        })),
        probabilities: decision.probabilities,
      });
      return decision;
    },
  };
}

async function runCase(session, base, resolver, testCase) {
  const context = await session.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/${testCase.page}`, { timeoutMs: 15_000 });
    await quietPage(page, 300, 5_000);
    if (testCase.targets) {
      const failure = await markTargets(page, testCase.targets);
      if (failure) return { case: testCase, skipped: failure };
    }
    const decisions = [];
    const result = await resolveTarget(
      page,
      recording(resolver, page, decisions),
      {
        operation: testCase.op,
        sentence: testCase.sentence,
        timeoutMs: 60_000,
        ...(repeatedMember ? { repeatedMember } : {}),
      },
    );
    const observation =
      result.kind === "resolved"
        ? {
            status: "resolved",
            pickedGold: (
              await goldOf(page, [result.target.driverTarget().ref])
            )[0],
            decisions,
          }
        : { status: "unresolved", reason: result.reason, decisions };
    return {
      case: testCase,
      observation: {
        status: observation.status,
        reason: observation.reason ?? null,
        pickedGold: observation.pickedGold ?? null,
        gate: result.diagnostic.gate ?? null,
        candidateCount: result.diagnostic.candidateCount,
        topOptions: result.diagnostic.topOptions,
      },
      score: scoreCase(testCase, observation),
      calls: result.calls,
    };
  } finally {
    await context.close();
  }
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function report(summary, results) {
  const lines = [
    `Locator eval: ${args.resolver}, ${summary.cases} cases (${summary.answerable} answerable, ${summary.unanswerable} none/ambiguous)`,
    "",
    `  success on answerable   ${percent(summary.successRate)}  (${summary.outcomes.correct}/${summary.answerable})`,
    `  wrong-action rate       ${percent(summary.wrongActionRate)}  (${summary.outcomes.wrong_action}/${summary.cases})`,
    `  correct abstain         ${percent(summary.abstainRate)}  (${summary.outcomes.correct_abstain}/${summary.unanswerable})`,
    `  false rejects           ${summary.outcomes.false_reject}`,
    `  model calls             ${summary.usage.calls}, ${summary.usage.inputTokens} input tokens, ${summary.usage.costUsd === null ? "unknown" : "$" + summary.usage.costUsd.toFixed(5)}`,
    "",
    "Failures by stage:",
    ...Object.entries(summary.stages).map(
      ([stage, n]) => `  ${stage.padEnd(28)} ${n}`,
    ),
    "",
    "By tag (ok/cases, wrong actions):",
    ...Object.entries(summary.tags).map(
      ([tag, t]) =>
        `  ${tag.padEnd(22)} ${String(t.ok).padStart(3)}/${String(t.cases).padEnd(3)} ${t.wrong ? `wrong ${t.wrong}` : ""}`,
    ),
    ...(Object.keys(summary.variants).length
      ? [
          "",
          "By coding variant (success on answerable, wrong actions, recall misses):",
          ...Object.entries(summary.variants).map(
            ([variant, v]) =>
              `  ${variant.padEnd(22)} ${percent(v.successRate).padStart(6)}  wrong ${v.wrong}  recall ${v.recall}  (${v.cases} cases)`,
          ),
        ]
      : []),
    "",
    "Failed cases:",
  ];
  for (const item of results) {
    const { outcome, stage, goldProbability, indistinguishable } = item.score;
    if (outcome === "correct" || outcome === "correct_abstain") continue;
    lines.push(
      `  ${outcome.padEnd(13)} ${(stage ?? "").padEnd(24)} ${item.case.id}` +
        `  [${item.observation.status === "resolved" ? `picked ${item.observation.pickedGold ?? "an unlabeled element"}` : `reason ${item.observation.reason}`}` +
        (goldProbability === null
          ? ""
          : `, gold p=${goldProbability.toFixed(2)}`) +
        (indistinguishable ? ", indistinguishable" : "") +
        "]",
    );
    if (!args.verbose) continue;
    lines.push(`      "${item.case.sentence}"`);
    for (const option of item.observation.topOptions)
      lines.push(
        `      ${option.probability.toFixed(3)}  ${option.role || "-"}  ${option.name}`,
      );
  }
  return lines.join("\n");
}

const cases = loadCases();
if (args.validate) {
  console.log(`${cases.length} cases are valid.`);
  process.exit(0);
}
if (cases.length === 0) throw new Error("No cases match the filters.");
const { resolver, cache } = await makeResolver();
const { server, base } = real
  ? await serveStore(store)
  : await serve(join(root, "pages"));
const session = await new PlaywrightBrowserDriver().launch({
  browser: "chromium",
});
const results = [];
try {
  for (const testCase of cases) {
    results.push(await runCase(session, base, resolver, testCase));
    if (!process.stdout.isTTY) continue;
    process.stdout.write(`\r${results.length}/${cases.length}`);
  }
} finally {
  cache?.save();
  await session.close();
  server.close();
}
if (process.stdout.isTTY) process.stdout.write("\r");
const skipped = results.filter((item) => item.skipped);
const scored = results.filter((item) => !item.skipped);
const summary = summarize(scored);
console.log(report(summary, scored));
if (skipped.length)
  console.log(
    ["", `Skipped ${skipped.length} case(s) whose targets did not resolve:`]
      .concat(skipped.map((item) => `  ${item.case.id}: ${item.skipped}`))
      .join("\n"),
  );
if (cache)
  console.log(`\nReply cache: ${cache.hits} hits, ${cache.misses} misses`);
const out =
  args.out ??
  join(
    root,
    "results",
    `${args.resolver}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ summary, results: scored, skipped }, null, 2) + "\n",
);
console.log(`\nResults: ${out}`);
