import type {
  ExploreFinding,
  ExploreRunResult,
  ExploreStepView,
} from "@sedum-dev/core";
import { REPORT_FONTS } from "./html-fonts.js";
import { esc } from "./report-text.js";

/**
 * `report.html` of `sedum explore`: one offline file. Findings come first,
 * each with its frame and the test `--shrink` wrote; then a step viewer
 * over the run's frames (with `--replay`), what the walk changed on the
 * server, what it covered and what Jev cost. Page text is escaped.
 */
export interface ExploreHtmlOptions {
  /** Frame bytes by their path in the run directory (`frames/…`). */
  readonly frames?: ReadonlyMap<string, Uint8Array>;
  /** How to invoke sedum in commands, e.g. `npx sedum`. Default `sedum`. */
  readonly command?: string;
}

const STYLE = `
:root{--bg:#F6F4ED;--card:#FBFAF5;--ink:#1A2420;--soft:#57655C;--rule:#D9D4C5;--green:#1D5B3E;--red:#C24328;--wash:#E8EEE7;
--serif:"Fraunces",Georgia,serif;--sans:"Inter",Helvetica,Arial,sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141A17;--card:#1B231F;--ink:#E7E4DA;--soft:#9AA79F;--rule:#34403A;--green:#7BC59C;--red:#F08A6E;--wash:#22302A}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
main{max-width:1180px;margin:0 auto;padding:28px 24px 64px}
h1,h2,h3{font-family:var(--serif);font-weight:500;margin:0}h1{font-size:34px}h2{font-size:26px;margin:40px 0 14px;border-top:3px solid var(--ink);padding-top:12px}
h3{font-size:20px}code,pre,.mono{font-family:var(--mono);font-size:13.5px}
pre{background:var(--card);border:1px solid var(--rule);padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:8px 0}
.brand{display:flex;gap:10px;align-items:center;font-family:var(--serif);font-size:20px;color:var(--soft)}
.verdict{display:inline-block;margin:10px 0 4px;padding:4px 12px;font-weight:600;border:1.5px solid var(--green);color:var(--green)}
.verdict.bad{border-color:var(--red);color:var(--red)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;margin-top:14px}
.fact{background:var(--card);border:1px solid var(--rule);padding:8px 10px}.fact b{display:block;font-size:18px}.fact span{color:var(--soft);font-size:13px}
.finding{background:var(--card);border:1px solid var(--rule);border-left:4px solid var(--red);padding:14px 16px;margin:14px 0}
.finding .head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.tag{font-family:var(--mono);font-weight:600;color:var(--red)}
.chip{font-family:var(--mono);font-size:12px;border:1px solid var(--rule);padding:1px 7px;color:var(--soft)}
.label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--soft);margin-top:10px}
.cols{display:grid;grid-template-columns:1.1fr 1fr;gap:16px}@media (max-width:860px){.cols{grid-template-columns:1fr}}
.frame{position:relative;border:1px solid var(--rule);background:#fff}.frame img{display:block;width:100%}
.box{position:absolute;border:3px solid var(--red);box-shadow:0 0 0 2px #fff}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-weight:600;color:var(--soft);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
tr.hit td{background:var(--wash)}tr.ev td:first-child{border-left:3px solid var(--red)}
.bar{height:10px;background:var(--green)}
.viewer{background:var(--card);border:1px solid var(--rule);padding:12px}.controls{display:flex;gap:10px;align-items:center;margin:10px 0}
.controls input{flex:1}button{font:inherit;padding:4px 12px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);cursor:pointer}
.events{color:var(--red);font-family:var(--mono);font-size:13px}.soft{color:var(--soft)}a{color:var(--green)}
`;

/** JSON for a script block: no character can end the block early. */
function json(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function money(usd: number | null): string {
  return usd === null ? "unknown" : `$${usd.toFixed(4)}`;
}

function dataUrl(
  frames: ReadonlyMap<string, Uint8Array> | undefined,
  path: string | undefined,
): string | null {
  const bytes = path ? frames?.get(path) : undefined;
  return bytes
    ? `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`
    : null;
}

function frameFigure(
  step: ExploreStepView | undefined,
  frames: ReadonlyMap<string, Uint8Array> | undefined,
): string {
  const after = dataUrl(frames, step?.frames?.after);
  const before = dataUrl(frames, step?.frames?.before);
  const src = after ?? before;
  if (!src)
    return `<p class="soft">No frame: run with <code>--replay</code> to capture them.</p>`;
  return `<div class="frame"><img alt="The page at step ${step!.step}" src="${src}"></div>`;
}

function testBlock(
  finding: ExploreFinding,
  artifacts: ExploreRunResult["artifacts"],
  command: string,
): string {
  const test = finding.test;
  const at = (file: string) => `${artifacts.directory}/${file}`;
  const rerun = `${command} explore --rerun ${at(artifacts.trace)}`;
  if (!test || "notShrunk" in test)
    return `${test ? `<p class="soft">Not shrunk: ${esc(test.notShrunk)}</p>` : ""}<div class="label">Reproduce the whole walk</div><pre>${esc(rerun)}</pre>`;
  return `<div class="label">Plain-English test · ${test.actionsBefore} → ${test.actionsAfter} actions · ${test.reproduced ? "reproduces" : "does not reproduce"} the failure</div>
<pre>${esc(test.yaml)}</pre><div class="label">Run it with the error flagged</div><pre>${esc(`${command} run ${at(test.path)} --detect browser`)}</pre>`;
}

function findingCard(
  finding: ExploreFinding,
  result: ExploreRunResult,
  options: ExploreHtmlOptions,
): string {
  const step = result.timeline.find((s) => s.step === finding.step);
  return `<section class="finding" id="finding-${esc(finding.id)}">
<div class="head"><span class="tag">${esc(finding.id)}</span><h3>${esc(finding.signature)}</h3></div>
<div class="soft"><span class="chip">${esc(finding.kind)}</span> step <a href="#step-${finding.step}" data-step="${finding.step}">${finding.step}</a> on <code>${esc(finding.route)}</code></div>
<div class="cols"><div><div class="label">What the browser or page said (untrusted)</div><pre>${esc(finding.message)}</pre>
${testBlock(finding, result.artifacts, options.command ?? "sedum")}</div><div>${frameFigure(step, options.frames)}</div></div></section>`;
}

function facts(result: ExploreRunResult): string {
  const writes = result.writes.reduce((n, w) => n + w.count, 0);
  const items: [string, string][] = [
    [`${result.steps.taken} / ${result.steps.requested}`, "steps"],
    [String(result.coverage.states), "states"],
    [String(result.coverage.routes.length), "kinds of page"],
    [String(writes), "server writes"],
    [`${(result.durationMs / 1000).toFixed(1)} s`, "duration"],
    [money(result.jev.costUsd), `Jev, ${result.jev.calls} calls`],
    [result.safety, "safety"],
    [String(result.seed), `seed · ${result.mode}`],
  ];
  return `<div class="facts">${items.map(([v, k]) => `<div class="fact"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>`;
}

/** A frame viewer over every step with a frame, driven by a small script. */
function viewer(
  result: ExploreRunResult,
  frames: ReadonlyMap<string, Uint8Array> | undefined,
): string {
  const shots = result.timeline.flatMap((s) => {
    const src =
      dataUrl(frames, s.frames?.before) ?? dataUrl(frames, s.frames?.after);
    if (!src) return [];
    const box = s.frames?.before ? s.frames.box : undefined;
    return [
      {
        step: s.step,
        src,
        box,
        action: s.action,
        route: s.route,
        events: s.signatures,
      },
    ];
  });
  if (!shots.length)
    return `<p class="soft">This run captured no frames. Run with <code>--replay</code> to step through it here.</p>`;
  return `<div class="viewer" id="viewer"><div class="frame"><img id="v-img" alt=""><div class="box" id="v-box" hidden></div></div>
<div class="controls"><button id="v-prev" type="button">◀</button><input id="v-range" type="range" min="0" max="${shots.length - 1}" value="0" aria-label="Step"><button id="v-next" type="button">▶</button></div>
<div><b id="v-step"></b> <span id="v-action"></span> <span class="soft" id="v-route"></span></div><div class="events" id="v-events"></div></div>
<script type="application/json" id="v-data">${json(shots)}</script>
<script>(() => {
const shots = JSON.parse(document.getElementById("v-data").textContent);
const $ = (id) => document.getElementById(id);
let at = 0;
const show = (i) => { at = Math.max(0, Math.min(shots.length - 1, i)); const s = shots[at];
  $("v-img").src = s.src; $("v-range").value = at; $("v-step").textContent = "Step " + s.step;
  $("v-action").textContent = s.action; $("v-route").textContent = s.route; $("v-events").textContent = s.events.join(" · ");
  const box = $("v-box"); box.hidden = !s.box;
  if (s.box) Object.assign(box.style, { left: s.box.x * 100 + "%", top: s.box.y * 100 + "%", width: s.box.width * 100 + "%", height: s.box.height * 100 + "%" }); };
$("v-prev").onclick = () => show(at - 1); $("v-next").onclick = () => show(at + 1);
$("v-range").oninput = (e) => show(Number(e.target.value));
document.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") show(at - 1); if (e.key === "ArrowRight") show(at + 1); });
document.querySelectorAll("[data-step]").forEach((a) => a.addEventListener("click", () => { const i = shots.findIndex((s) => s.step === Number(a.dataset.step)); if (i >= 0) show(i); }));
show(0); })();</script>`;
}

function stepRows(result: ExploreRunResult): string {
  return result.timeline
    .map(
      (s) =>
        `<tr id="step-${s.step}" class="${s.signatures.length ? "ev" : ""}"><td class="mono"><a href="#viewer" data-step="${s.step}">${s.step}</a></td><td><code>${esc(s.route)}</code>${s.pageKind ? ` <span class="chip">${esc(s.pageKind)}</span>` : ""}</td><td>${esc(s.action)}${s.planned ? ' <span class="chip">plan</span>' : ""}${s.outcome === "acted" ? "" : ` <span class="soft">(${esc(s.outcome)})</span>`}</td><td class="events">${esc(s.signatures.join(" · "))}${s.writes.length ? `<div class="soft">${esc(s.writes.join(", "))}</div>` : ""}</td></tr>`,
    )
    .join("");
}

function coverage(result: ExploreRunResult): string {
  const kinds = Object.entries(result.coverage.pageKinds).sort(
    (a, b) => b[1] - a[1],
  );
  const max = Math.max(1, ...kinds.map(([, n]) => n));
  return `<div class="cols"><table><tr><th>Page kind</th><th>Visits</th><th></th></tr>${kinds.map(([k, n]) => `<tr><td>${esc(k)}</td><td>${n}</td><td style="width:50%"><div class="bar" style="width:${(100 * n) / max}%"></div></td></tr>`).join("")}</table>
<table><tr><th>Page</th><th>Steps</th></tr>${result.coverage.routes
    .slice(0, 30)
    .map(
      (r) =>
        `<tr><td><code>${esc(r.route)}</code></td><td>${r.visits}</td></tr>`,
    )
    .join("")}</table></div>`;
}

function writes(result: ExploreRunResult): string {
  if (!result.writes.length) return `<p>No server writes observed.</p>`;
  return `<p class="soft">Successful requests that may change data: not reads, beacons or failures.</p><table><tr><th>Request</th><th>Count</th><th>First step</th></tr>${result.writes.map((w) => `<tr><td><code>${esc(w.endpoint)}</code></td><td>${w.count}</td><td><a href="#step-${w.firstStep}">${w.firstStep}</a></td></tr>`).join("")}</table>`;
}

function receipt(result: ExploreRunResult): string {
  const { jev } = result;
  const latency = jev.latencyMs
    ? `, p50 ${jev.latencyMs.p50} ms, p95 ${jev.latencyMs.p95} ms`
    : "";
  return `<p>${jev.calls} calls, ${jev.inputTokens} input tokens, ${esc(money(jev.costUsd))}${latency}.</p>${jev.errors.length ? `<div class="label">Failed calls (untrusted)</div><pre>${esc(jev.errors.join("\n"))}</pre>` : ""}`;
}

export function renderExploreHtml(
  result: ExploreRunResult,
  options: ExploreHtmlOptions = {},
): string {
  const n = result.findings.length;
  const skipped = result.skipped.length
    ? `<h2>Not clicked</h2><p class="soft">${result.safety === "off" ? "Safety was off; these would have ended the session." : `Safety was ${esc(result.safety)}: destructive or session-ending.`}</p><p>${result.skipped.map((s) => `<span class="chip">${esc(s)}</span>`).join(" ")}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Exploration of ${esc(result.startUrl)}</title><style>${REPORT_FONTS}${STYLE}</style></head><body><main>
<div class="brand">sedum explore <span class="chip">experimental</span></div>
<h1>Exploration of <code>${esc(result.startUrl)}</code></h1>
<div class="verdict ${n ? "bad" : ""}">${n ? `${n} finding${n === 1 ? "" : "s"}` : "No findings"}</div>${result.stopReason ? `<p class="soft">Stopped early: ${esc(result.stopReason)}</p>` : ""}
${facts(result)}
<h2>Findings</h2>${n ? result.findings.map((f) => findingCard(f, result, options)).join("") : "<p>None.</p>"}
<h2>Steps</h2>${viewer(result, options.frames)}
<table><tr><th>Step</th><th>Page</th><th>Action</th><th>Findings and writes</th></tr>${stepRows(result)}</table>
<h2>What the walk changed</h2>${writes(result)}
<h2>Coverage</h2>${coverage(result)}${skipped}
<h2>Jev</h2>${receipt(result)}
</main></body></html>
`;
}
