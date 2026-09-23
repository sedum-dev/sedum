import {
  validateRunResult,
  type ResultAttempt,
  type ResultCall,
  type ResultStep,
  type ResultTest,
  type RunResult,
} from "@sedum-dev/core";
import { REPORT_CSS } from "./html-styles.js";
import {
  decisionLines,
  duration,
  score,
  selectedAttempt,
  shellArg,
  sourceStack,
  testOrder,
  testStatus,
  testStatusLabel,
} from "./shared.js";
import { REPORT_FONTS } from "./html-fonts.js";
import { REPORT_JS } from "./html-interactions.js";

export interface HtmlReportOptions {
  /** Captured replay JPEGs, keyed by the relative path recorded in RunResult. */
  readonly replayFrames?: ReadonlyMap<string, string>;
}

const mark =
  '<svg viewBox="0 0 32 32" aria-hidden="true" fill="currentColor"><g><ellipse cx="16" cy="7.2" rx="3" ry="6.6"/><ellipse cx="16" cy="7.2" rx="3" ry="6.6" transform="rotate(72 16 16)"/><ellipse cx="16" cy="7.2" rx="3" ry="6.6" transform="rotate(144 16 16)"/><ellipse cx="16" cy="7.2" rx="3" ry="6.6" transform="rotate(216 16 16)"/><ellipse cx="16" cy="7.2" rx="3" ry="6.6" transform="rotate(288 16 16)"/></g><circle cx="16" cy="16" r="2.4" fill="#C24328"/></svg>';

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function json(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) =>
      ({
        "<": "\\u003c",
        ">": "\\u003e",
        "&": "\\u0026",
        "\u2028": "\\u2028",
        "\u2029": "\\u2029",
      })[char]!,
  );
}

function money(value: number | null): string {
  return value === null ? "unknown" : "$" + value.toFixed(value < 0.01 ? 6 : 4);
}
function calls(result: RunResult): ResultCall[] {
  return [
    ...result.setupCalls,
    ...result.tests.flatMap((test) =>
      test.attempts.flatMap((attempt) => [
        ...(attempt.calls ?? []),
        ...attempt.steps.flatMap((step) => step.calls),
      ]),
    ),
  ];
}
function callCost(step: ResultStep): number | null {
  return step.calls.every((call) => call.costUsd !== null)
    ? step.calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0)
    : null;
}

function bar(step: ResultStep): string {
  const judgement = step.judgement;
  if (!judgement) return '<span class="soft">—</span>';
  const value = judgement.holds;
  const width = Math.max(0, Math.min(100, value * 100));
  const lines = decisionLines(judgement);
  const shown = score(value, lines ? [lines.fail, lines.pass] : []);
  const ticks =
    step.kind === "verify" && lines
      ? '<span class="tick fail" style="left:' +
        (lines.fail * 100).toFixed(1) +
        '%"></span>' +
        '<span class="tick pass" style="left:' +
        (lines.pass * 100).toFixed(1) +
        '%"></span>'
      : "";
  const tone =
    step.kind === "measure"
      ? "measure"
      : step.verdict === "failed"
        ? "failed"
        : step.flags.length
          ? "marginal"
          : "ok";
  const note =
    step.kind === "measure"
      ? "observation, no decision line"
      : !lines
        ? "decision lines unavailable"
        : "fails below " +
          score(lines.fail) +
          "; passes at " +
          score(lines.pass);
  return (
    '<span class="pwrap" title="' +
    esc("holds " + shown + "; " + note) +
    '">' +
    '<span class="ptrack"><span class="pfill ' +
    tone +
    '" style="width:' +
    width.toFixed(1) +
    '%"></span>' +
    ticks +
    "</span>" +
    '<span class="pnum">' +
    shown +
    "</span></span>"
  );
}

function stepDetails(step: ResultStep): string {
  const judgement = step.judgement;
  const locator = step.locator;
  const page =
    step.page.status === "available"
      ? "<div><b>page</b> " +
        esc(step.page.url) +
        " · " +
        esc(step.page.title) +
        "</div>"
      : "<div><b>page</b> " +
        esc(step.page.status + ": " + step.page.reason) +
        "</div>";
  const lines = judgement ? decisionLines(judgement) : null;
  const scores = judgement
    ? "<div><b>judgement</b> holds " +
      score(judgement.holds, lines ? [lines.fail, lines.pass] : []) +
      " · contradiction " +
      score(judgement.contradicted, [judgement.contradictionCutoff]) +
      " / cutoff " +
      score(judgement.contradictionCutoff) +
      " · fail below " +
      score(lines?.fail ?? null) +
      " · pass at " +
      score(judgement.threshold) +
      "</div>" +
      (judgement.judgedExcerpt
        ? "<blockquote>" + esc(judgement.judgedExcerpt) + "</blockquote>"
        : "")
    : "";
  const choices = locator
    ? "<div><b>locator</b> " +
      esc(locator.source) +
      " · confidence " +
      score(locator.confidence) +
      (locator.cache
        ? " · cache " +
          esc(
            locator.cache.outcome +
              (locator.cache.reason ? " (" + locator.cache.reason + ")" : "") +
              (locator.cache.targetChanged ? ", target changed" : ""),
          )
        : "") +
      "</div><div><b>candidates</b> " +
      (locator.options.length
        ? locator.options
            .map((option) =>
              esc(
                option.label +
                  (option.role ? " [" + option.role + "]" : "") +
                  " " +
                  score(option.probability),
              ),
            )
            .join(" · ")
        : "none recorded") +
      "</div>"
    : "";
  const observations = step.observations.length
    ? "<div><b>observations</b> " +
      step.observations
        .map((o) =>
          esc(
            "#" +
              o.ordinal +
              " " +
              o.outcome +
              (o.reason ? " (" + o.reason + ")" : "") +
              (o.timeoutReason ? " timeout: " + o.timeoutReason : ""),
          ),
        )
        .join(" · ") +
      "</div>"
    : "";
  const error = step.error
    ? '<div class="error"><b>' +
      esc(step.error.code) +
      "</b> " +
      esc(step.error.message) +
      (step.error.callLog?.length
        ? "<pre>" + esc(step.error.callLog.join("\n")) + "</pre>"
        : "") +
      "</div>"
    : "";
  const evidence =
    "<div><b>evidence</b> " +
    esc(step.evidence.status) +
    (step.evidence.status === "captured"
      ? " · " + esc(step.evidence.path)
      : " · " + esc(step.evidence.reason)) +
    " · <b>replay</b> " +
    esc(step.replayFrame?.status ?? "not requested") +
    "</div>";
  return (
    '<div class="step-detail"><div><b>source</b> ' +
    esc(sourceStack(step.sourceStack)) +
    " · " +
    esc(step.phase) +
    " · " +
    duration(step.elapsedMs) +
    "</div>" +
    page +
    scores +
    choices +
    observations +
    error +
    evidence +
    "</div>"
  );
}

function stepRow(step: ResultStep, attemptId: string): string {
  const tone =
    step.verdict === "failed"
      ? "failed"
      : step.flags.length
        ? "marginal"
        : "ok";
  const symbol =
    step.verdict === "failed"
      ? "×"
      : step.flags.length
        ? "!"
        : step.verdict === "passed"
          ? "✓"
          : "·";
  const kindGroup =
    step.kind === "action"
      ? "action"
      : step.kind === "measure"
        ? "measure"
        : "verify";
  const flags = step.flags.length
    ? '<span class="step-flags">' + esc(step.flags.join(", ")) + "</span>"
    : "";
  const detail = step.detail
    ? '<span class="detail">' + esc(step.detail) + "</span>"
    : "";
  const locator = step.locator?.source ?? (step.calls.length ? "model" : "—");
  return (
    '<tr class="s-' +
    tone +
    '" data-step="' +
    step.index +
    '" data-attempt="' +
    esc(attemptId) +
    '">' +
    '<td class="ix num">' +
    step.index +
    '</td><td class="sym">' +
    symbol +
    "</td>" +
    '<td class="step"><span class="cell"><span class="kind kind-' +
    kindGroup +
    '">' +
    esc(step.operation || step.kind) +
    "</span>" +
    '<span class="what ' +
    (step.kind !== "action" ? "claim" : "") +
    '">' +
    esc(step.sentence) +
    "</span>" +
    detail +
    flags +
    "</span></td>" +
    '<td><span class="src src-' +
    esc(locator) +
    '">' +
    esc(locator) +
    "</span></td>" +
    '<td class="p">' +
    bar(step) +
    "</td>" +
    '<td class="num soft">' +
    (step.locator ? score(step.locator.confidence) : "") +
    "</td>" +
    '<td class="num soft">' +
    duration(step.elapsedMs) +
    "</td>" +
    '<td class="num soft">' +
    (step.calls.length ? money(callCost(step)) : "—") +
    "</td></tr>" +
    '<tr class="step-extra"><td colspan="8"><details' +
    (step.verdict === "failed" || step.flags.length ? " open" : "") +
    "><summary>details · " +
    esc(sourceStack(step.sourceStack)) +
    "</summary>" +
    stepDetails(step) +
    "</details></td></tr>"
  );
}

interface PlayerFrame {
  src: string | null;
  status: string;
  label: string;
  step: number;
  attempt: string;
  box: ResultStep["targetBox"];
}
function replay(
  test: ResultTest,
  attempt: ResultAttempt,
  frames: ReadonlyMap<string, string> | undefined,
): string {
  if (!frames) return "";
  const entries: PlayerFrame[] = attempt.steps
    .filter((step) => step.replayFrame !== null)
    .map((step) => {
      const frame = step.replayFrame!;
      const data =
        frame.status === "captured" ? frames.get(frame.path) : undefined;
      return {
        src: data ? "data:image/jpeg;base64," + data : null,
        status:
          frame.status === "captured" && !data ? "unavailable" : frame.status,
        label: step.index + ". " + step.operation + " " + step.sentence,
        step: step.index,
        attempt: attempt.id,
        box: step.targetBox,
      };
    });
  if (!entries.length) return "";
  const ticks = entries
    .map(
      (frame, index) =>
        '<button class="fr fr-' +
        (frame.status === "captured" ? "ok" : "failed") +
        '" type="button" data-i="' +
        index +
        '" aria-label="step ' +
        frame.step +
        " · " +
        esc(frame.status) +
        '"></button>',
    )
    .join("");
  return (
    '<figure class="replay" aria-label="visual replay for ' +
    esc(test.description || test.file) +
    '">' +
    '<div class="screen"><img class="layer" alt="" aria-hidden="true"><img class="layer" alt="" aria-hidden="true"><div class="mark" hidden></div><div class="frame-placeholder" hidden></div></div>' +
    '<div class="controls"><button class="pb" type="button" data-act="prev" aria-label="previous step">◀</button>' +
    '<button class="pb play" type="button" data-act="play" aria-label="play">▶</button>' +
    '<button class="pb" type="button" data-act="next" aria-label="next step">▶▶</button>' +
    '<span class="counter num"></span><figcaption class="frame-label"></figcaption>' +
    '<span class="speeds"><button class="pb" type="button" data-speed="1">1×</button><button class="pb" type="button" data-speed="2" aria-current="true">2×</button><button class="pb" type="button" data-speed="4">4×</button></span>' +
    '<button class="pb grow" type="button" data-act="expand" aria-pressed="false">expand</button></div>' +
    '<div class="strip">' +
    ticks +
    '</div><script type="application/json" class="frames">' +
    json(entries) +
    "</script></figure>" +
    '<p class="replay-note">Frames show what was visible. Assertion grades use the recorded judgement and page excerpt.</p>'
  );
}

function attemptSection(
  test: ResultTest,
  attempt: ResultAttempt,
  frames: ReadonlyMap<string, string> | undefined,
): string {
  const current = attempt.id === test.selectedAttemptId;
  const problems = attempt.problems
    .map(
      (problem) =>
        '<p class="problem"><b>' +
        esc(problem.outcome + " · " + problem.origin) +
        "</b> " +
        esc(problem.error.message) +
        " · " +
        esc(problem.sourceStack.map((s) => s.file + ":" + s.line).join(" → ")) +
        "</p>",
    )
    .join("");
  const rows = attempt.steps.map((step) => stepRow(step, attempt.id)).join("");
  return (
    '<details class="attempt"' +
    (current ? " open" : "") +
    "><summary>attempt " +
    attempt.ordinal +
    " · " +
    esc(attempt.verdict ?? attempt.state) +
    (attempt.flags.length ? " · flagged" : "") +
    (current ? " · selected" : "") +
    " · " +
    duration(attempt.elapsedMs) +
    "</summary>" +
    (attempt.timeoutReason
      ? '<p class="problem">timeout: ' + esc(attempt.timeoutReason) + "</p>"
      : "") +
    (attempt.error
      ? '<p class="problem">' + esc(attempt.error.message) + "</p>"
      : "") +
    problems +
    replay(test, attempt, frames) +
    (rows
      ? '<div class="tablewrap"><table class="steps"><thead><tr><th class="ix">#</th><th></th><th>step</th><th>source</th><th class="p">p</th><th>conf</th><th>ms</th><th>cost</th></tr></thead><tbody>' +
        rows +
        "</tbody></table></div>"
      : '<p class="empty">No steps executed in this attempt.</p>') +
    "</details>"
  );
}

function testSection(
  test: ResultTest,
  index: number,
  frames: ReadonlyMap<string, string> | undefined,
): string {
  const tone = testStatus(test);
  const attempt = selectedAttempt(test);
  const steps = attempt?.steps ?? [];
  const failed = steps.filter((step) => step.verdict === "failed").length;
  const flagged = steps.filter((step) => step.flags.length).length;
  const summary = [
    failed && failed + " failed",
    flagged && flagged + " flagged",
    steps.length + " steps",
    test.attempts.length > 1 && test.attempts.length + " attempts",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    '<section class="test" id="flow-' +
    index +
    '" data-status="' +
    tone +
    '">' +
    '<details class="test-body"' +
    (tone === "failed" || tone === "incomplete" ? " open" : "") +
    ">" +
    '<summary class="test-head"><div><span class="label">flow · ' +
    esc(test.file) +
    "</span><h2>" +
    esc(test.description || test.file) +
    '</h2></div><span class="test-head-right">' +
    '<span class="test-summary label">' +
    esc(summary) +
    "</span>" +
    '<span class="badge b-' +
    (tone === "flagged"
      ? "marginal"
      : tone === "incomplete"
        ? "diverged"
        : tone === "passed"
          ? "ok"
          : "failed") +
    '">' +
    esc(testStatusLabel(test)) +
    "</span></span></summary>" +
    '<div class="test-content"><p class="test-meta label"><span>' +
    esc(summary) +
    "</span><span>" +
    esc(test.file) +
    "</span>" +
    (test.tags.length ? "<span>" + esc(test.tags.join(", ")) + "</span>" : "") +
    '</p><p class="rerun"><span class="label">rerun</span> <code>sedum run ' +
    esc(shellArg(test.file)) +
    "</code></p>" +
    test.attempts.map((item) => attemptSection(test, item, frames)).join("") +
    (!test.attempts.length
      ? '<p class="empty">This flow was selected but did not execute.</p>'
      : "") +
    "</div></details></section>"
  );
}

function receipt(result: RunResult): string {
  const all = calls(result);
  const rates = new Map<
    string,
    {
      model: string;
      input: number | null;
      output: number | null;
      source: string | null;
      checked: string | null;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      complete: boolean;
    }
  >();
  for (const call of all) {
    const key = JSON.stringify([
      call.model,
      call.inputUsdPerMillion,
      call.outputUsdPerMillion,
      call.rateSource,
      call.rateCheckedAt,
    ]);
    const prior = rates.get(key);
    rates.set(key, {
      model: call.model,
      input: call.inputUsdPerMillion,
      output: call.outputUsdPerMillion,
      source: call.rateSource,
      checked: call.rateCheckedAt,
      calls: (prior?.calls ?? 0) + call.attempts,
      inputTokens: (prior?.inputTokens ?? 0) + call.inputTokens,
      outputTokens: (prior?.outputTokens ?? 0) + call.outputTokens,
      cost: (prior?.cost ?? 0) + (call.costUsd ?? 0),
      complete: (prior?.complete ?? true) && call.costUsd !== null,
    });
  }
  const rateRows = [...rates.values()]
    .map(
      (rate) =>
        '<div class="r-row r-model"><span>model</span><span>' +
        esc(rate.model) +
        "</span></div>" +
        '<div class="r-row r-usage"><span>input</span><span>' +
        rate.inputTokens.toLocaleString("en-US") +
        " tk</span><span>" +
        esc(
          rate.complete && rate.input !== null
            ? money((rate.inputTokens * rate.input) / 1_000_000)
            : "unknown",
        ) +
        "</span></div>" +
        '<div class="r-row indent"><span>at ' +
        esc(rate.input === null ? "unknown rate" : "$" + rate.input + "/1M") +
        "</span></div>" +
        '<div class="r-row r-usage"><span>output</span><span>' +
        rate.outputTokens.toLocaleString("en-US") +
        " tk</span><span>" +
        esc(
          rate.complete && rate.output !== null
            ? money((rate.outputTokens * rate.output) / 1_000_000)
            : "unknown",
        ) +
        "</span></div>" +
        '<div class="r-row indent"><span>at ' +
        esc(rate.output === null ? "unknown rate" : "$" + rate.output + "/1M") +
        "</span></div>" +
        '<div class="r-row r-usage"><span>calls</span><span>' +
        rate.calls +
        "</span><span>" +
        esc(rate.complete ? money(rate.cost) : "unknown") +
        "</span></div>" +
        '<div class="r-provenance">' +
        esc(rate.source ?? "source unavailable") +
        (rate.checked ? " · " + esc(rate.checked) : "") +
        "</div>",
    )
    .join('<hr class="r-rule">');
  return (
    '<section id="receipt" class="receipt-band"><div class="receipt-grid"><article class="receipt" aria-label="receipt for this run">' +
    '<div class="r-center"><div class="r-head">sedum</div><div class="r-sub">run receipt · № ' +
    esc(result.runId.slice(0, 8).toUpperCase()) +
    "</div>" +
    '<div class="r-sub">' +
    esc(
      new Date(result.startedAt).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }),
    ) +
    " UTC</div></div>" +
    '<hr class="r-rule"><div class="r-row"><span>flows</span><span>' +
    result.tests.length +
    "</span></div>" +
    '<div class="r-row"><span>steps, selected</span><span>' +
    (result.totals.passedSteps + result.totals.failedSteps) +
    "</span></div>" +
    '<div class="r-row"><span>model calls, all attempts</span><span>' +
    result.totals.modelCalls +
    "</span></div>" +
    '<div class="r-row"><span>duration</span><span>' +
    duration(result.elapsedMs) +
    "</span></div>" +
    '<hr class="r-rule">' +
    (rateRows || '<div class="r-row"><span>no model calls</span></div>') +
    '<hr class="r-rule"><div class="r-row r-total"><span>provider total</span><span>' +
    esc(
      result.totals.costComplete
        ? money(result.totals.costUsd)
        : "unknown or incomplete",
    ) +
    "</span></div>" +
    '<hr class="r-rule"><div class="r-row"><span>Sedum markup</span><span>$0.000000</span></div>' +
    '<div class="r-total-band"><span>total</span><span>' +
    esc(
      result.totals.costComplete
        ? money(result.totals.costUsd)
        : "unknown or incomplete",
    ) +
    "</span></div>" +
    '<div class="r-footnote">recorded provider usage across all attempts</div>' +
    '<div class="barcode" aria-hidden="true"></div></article></div></section>'
  );
}

const extraCss = `
.test-head-right{display:flex;align-items:center;gap:1.2rem}.test-summary{max-width:32ch;text-align:right}
.attempt{border-top:1px solid var(--rule);margin-top:1.2rem;padding-top:.7rem}.attempt>summary{cursor:pointer;font-family:var(--mono);font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--soft)}
.attempt[open]>summary{color:var(--ink)}.step-extra td{padding:0 0 .7rem 3.2rem!important;background:transparent!important}
.step-extra details{font-size:.75rem;color:var(--soft)}.step-extra summary{cursor:pointer;font-family:var(--mono);font-size:.66rem}
.step-detail{padding:.5rem .9rem;border-left:2px solid var(--rule);display:grid;gap:.35rem;overflow-wrap:anywhere}
.step-detail b{font-family:var(--mono);font-size:.66rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink);font-weight:500}
.step-detail blockquote{margin:.25rem 0;padding:.3rem .7rem;border-left:2px solid var(--gold);font-family:var(--serif);font-style:italic;color:var(--ink)}
.step-detail pre{white-space:pre-wrap;margin:.3rem 0}.step-flags{font-family:var(--mono);font-size:.65rem;color:var(--gold);grid-column:2}
.problem{background:color-mix(in srgb,var(--signal) 8%,transparent);padding:.55rem .8rem;margin:.8rem 0;font-size:.8rem;overflow-wrap:anywhere}
.rerun,.replay-note,.empty{font-size:.78rem;color:var(--soft);margin:.6rem 0}.rerun code{color:var(--ink)}.rerun .label{margin-right:.5rem}
.r-model span:last-child{text-align:right;overflow-wrap:anywhere}
.r-usage{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(5.5rem,auto);gap:.7rem}
.r-usage span:last-child{text-align:right}
.r-provenance{font-size:.64rem;line-height:1.45;color:var(--soft);padding-left:1.1rem;margin-top:.35rem;overflow-wrap:anywhere}
.r-total-band{background:var(--strong);color:var(--paper);margin:.9rem -1.5rem 0;padding:.75rem 1.5rem;display:flex;justify-content:space-between;gap:1rem;font-size:.8rem;font-weight:500}
.r-total-band span:last-child{text-align:right;overflow-wrap:anywhere}
.r-footnote{color:var(--soft);font-size:.62rem;line-height:1.45;margin-top:.65rem}
.frame-placeholder{position:absolute;inset:0;display:grid;place-items:center;font-family:var(--mono);font-size:.75rem;color:var(--soft)}
.frame-placeholder[hidden]{display:none}
.test[hidden]{display:none}.filters button[aria-current="false"]{background:none}.steps .step{min-width:17rem}
.steps td,.steps th{overflow-wrap:anywhere}.replay .screen:has(.layer:not([src])){background:var(--paper2)}
@media(max-width:700px){.test-head-right{display:block;text-align:right}.test-summary{display:none}.receipt-grid{grid-template-columns:1fr}.steps{min-width:780px}}
@media print{
  :root,:root[data-theme="dark"]{--paper:#fff;--paper2:#f4f2ea;--card:#fff;--ink:#1A2420;--soft:#57655C;--rule:#D9D4C5;--strong:#1A2420;--green:#1D5B3E;--signal:#C24328;--gold:#B4841F;--wash:#E8EEE7}
  details::details-content{content-visibility:visible!important;display:block!important}
  .test[hidden]{display:block!important}.test-body:not([open])>.test-content{display:block!important}.attempt:not([open])>*:not(summary){display:block!important}.step-extra details:not([open])>*:not(summary){display:block!important}.filters,.replay .controls,.replay .strip{display:none!important}.test{break-inside:auto}.receipt{break-inside:avoid}
}
`;

export function renderHtml(
  result: RunResult,
  options: HtmlReportOptions = {},
): string {
  const value = validateRunResult(result);
  const tests = value.tests
    .map((test, index) => ({ test, index }))
    .sort((a, b) => testOrder(a.test) - testOrder(b.test));
  const counts = { failed: 0, flagged: 0, passed: 0, incomplete: 0 };
  for (const test of value.tests) counts[testStatus(test)]++;
  const headline =
    value.state === "error" || value.state === "interrupted"
      ? value.tests.length +
        ' flows, <em class="v-failed">' +
        esc(value.state) +
        "</em>."
      : value.tests.length +
        " " +
        (value.tests.length === 1 ? "flow" : "flows") +
        ', <em class="v-' +
        (counts.failed ? "failed" : counts.flagged ? "marginal" : "ok") +
        '">' +
        (counts.failed
          ? counts.failed + " failed"
          : counts.flagged
            ? counts.flagged + " flagged"
            : "all passed") +
        "</em>.";
  const chips = [
    '<button type="button" data-filter="all" aria-current="true">all · ' +
      value.tests.length +
      "</button>",
    ...(["failed", "incomplete", "flagged", "passed"] as const)
      .filter((key) => counts[key] > 0)
      .map(
        (key) =>
          '<button type="button" data-filter="' +
          key +
          '">' +
          key +
          " · " +
          counts[key] +
          "</button>",
      ),
  ];
  const issues = (value.discoveryProblems ?? [])
    .map(
      (problem) =>
        '<p class="problem">' +
        esc(
          problem.file +
            (problem.line ? ":" + problem.line : "") +
            " · " +
            problem.message +
            " Fix: " +
            problem.fix,
        ) +
        "</p>",
    )
    .join("");
  const runError = value.error
    ? '<p class="problem"><b>' +
      esc(value.error.code) +
      "</b> " +
      esc(value.error.message) +
      "</p>"
    : "";
  const lede =
    counts.failed +
    " failed · " +
    counts.flagged +
    " flagged · " +
    counts.passed +
    " passed" +
    (counts.incomplete ? " · " + counts.incomplete + " incomplete" : "") +
    ". Open a flow for its attempts, steps, evidence and exact decision lines.";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex">' +
    "<title>Sedum — run report · " +
    esc(value.runId) +
    "</title><style>" +
    REPORT_FONTS +
    REPORT_CSS +
    extraCss +
    "</style></head><body>" +
    '<header class="mast"><div class="wrap"><a class="mark" href="#top">' +
    mark +
    'sedum</a><div class="mast-actions">' +
    '<span class="crumb">run report · № ' +
    esc(value.runId.slice(0, 8).toUpperCase()) +
    "</span>" +
    '<button class="tgl" type="button" data-theme-toggle aria-label="toggle dark mode">◐</button></div></div></header>' +
    '<main class="wrap" id="top"><section class="head"><div class="rule-heavy"></div><p class="label" style="margin-bottom:1.2rem">' +
    esc(
      new Date(value.startedAt).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }),
    ) +
    " UTC · run " +
    esc(value.runId) +
    "</p><h1>" +
    headline +
    '</h1><p class="lede">' +
    esc(lede) +
    "</p>" +
    '<div class="strip"><div><span class="label">selected</span><div class="num">' +
    value.totals.selectedTests +
    "</div></div>" +
    '<div><span class="label">passed</span><div class="num">' +
    value.totals.passedTests +
    "</div></div>" +
    '<div><span class="label">failed</span><div class="num">' +
    value.totals.failedTests +
    "</div></div>" +
    '<div><span class="label">flagged steps</span><div class="num">' +
    value.totals.flaggedSteps +
    "</div></div>" +
    '<div><span class="label">duration</span><div class="num">' +
    duration(value.elapsedMs) +
    "</div></div></div>" +
    '<div class="filters" role="group" aria-label="filter flows">' +
    chips.join("") +
    '<button type="button" class="expand-all" data-act="expand-all" aria-pressed="false">expand all</button></div>' +
    "</section>" +
    runError +
    issues +
    tests
      .map(({ test, index }) =>
        testSection(test, index + 1, options.replayFrames),
      )
      .join("") +
    (value.tests.length
      ? ""
      : '<p class="empty">No flows were recorded for this run.</p>') +
    receipt(value) +
    "</main><script>" +
    REPORT_JS +
    "</script></body></html>\n"
  );
}
