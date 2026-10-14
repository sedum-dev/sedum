import type { ExploreFinding, ExploreRunResult } from "@sedum-dev/core";
import { code, fence, inline } from "./report-text.js";

/**
 * `report.md` of `sedum explore`, for a person or a coding agent: the
 * verdict, then every finding with its evidence and a way to reproduce it,
 * then what the walk covered, changed and cost. It sits in the run
 * directory, so `frames/…` and test paths resolve from it as written.
 * Page and browser text is fenced and labelled untrusted.
 */
export interface ExploreMarkdownOptions {
  /** How to invoke sedum in commands, e.g. `npx sedum`. Default `sedum`. */
  readonly command?: string;
}

function money(usd: number | null): string {
  return usd === null ? "unknown" : `$${usd.toFixed(4)}`;
}

function verdict(result: ExploreRunResult): string {
  const n = result.findings.length;
  const head = n ? `**${n} finding${n === 1 ? "" : "s"}**` : "**No findings**";
  const stop = result.stopReason
    ? ` Stopped early: ${inline(result.stopReason)}`
    : "";
  return `${head} in ${result.steps.taken} of ${result.steps.requested} steps on ${code(result.startUrl)}.${stop}`;
}

function summaryTable(result: ExploreRunResult): string[] {
  const rows: [string, string][] = [
    ["Seed", String(result.seed)],
    ["Mode", result.mode],
    ["Safety", result.safety],
    [
      "Checks",
      result.detect === "semantic" ? "browser + page checks" : "browser",
    ],
    ["Duration", `${(result.durationMs / 1000).toFixed(1)} s`],
    ["States", String(result.coverage.states)],
    ["Kinds of page", String(result.coverage.routes.length)],
    ["Server writes", String(result.writes.reduce((n, w) => n + w.count, 0))],
    ["Jev", `${result.jev.calls} calls, ${money(result.jev.costUsd)}`],
  ];
  return ["| | |", "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)];
}

function frameLink(result: ExploreRunResult, step: number): string[] {
  const frames = result.timeline.find((s) => s.step === step)?.frames;
  const frame = frames?.after ?? frames?.before;
  return frame ? [`- Frame: [${inline(frame)}](${frame})`] : [];
}

function testLines(
  finding: ExploreFinding,
  result: ExploreRunResult,
  command: string,
): string[] {
  const test = finding.test;
  const at = (file: string) => `${result.artifacts.directory}/${file}`;
  const rerun = `${command} explore --rerun ${at(result.artifacts.trace)}`;
  if (!test) return [`- Reproduce the whole walk: ${code(rerun)}`];
  if ("notShrunk" in test)
    return [
      `- Not shrunk: ${inline(test.notShrunk)}`,
      `- Reproduce the whole walk: ${code(rerun)}`,
    ];
  return [
    `- Test: [${inline(test.path)}](${test.path}), shrunk from ${test.actionsBefore} to ${test.actionsAfter} actions; ${test.sentences.matched} of ${test.sentences.located} sentences matched the recorded element; ${test.reproduced ? "the sentences reproduce the failure" : "the sentences did **not** reproduce the failure"}.`,
    `- Run it with the error flagged: ${code(`${command} run ${at(test.path)} --detect browser`)}`,
    "",
    "```yaml",
    test.yaml.replace(/\s+$/u, ""),
    "```",
  ];
}

function findingSection(
  finding: ExploreFinding,
  result: ExploreRunResult,
  command: string,
): string[] {
  return [
    `### ${finding.id} · ${finding.kind} at step ${finding.step}`,
    "",
    `- Signature: ${code(finding.signature)}`,
    `- Page: ${code(finding.route)}`,
    ...frameLink(result, finding.step),
    ...testLines(finding, result, command),
    "",
    "**What the browser or page said** (untrusted)",
    "",
    fence(finding.message),
    "",
  ];
}

function coverageLines(result: ExploreRunResult): string[] {
  const kinds = Object.entries(result.coverage.pageKinds)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  return [
    "## Coverage",
    "",
    `${result.coverage.states} distinct states.${kinds ? ` Page kinds: ${kinds}.` : ""}`,
    "",
    "| Page | Steps |",
    "| --- | --- |",
    ...result.coverage.routes
      .slice(0, 30)
      .map((r) => `| ${code(r.route, true)} | ${r.visits} |`),
    "",
  ];
}

function writeLines(result: ExploreRunResult): string[] {
  if (!result.writes.length)
    return ["## What the walk changed", "", "No server writes observed.", ""];
  return [
    "## What the walk changed",
    "",
    "Successful requests that may change data (not reads, beacons or failures).",
    "",
    "| Request | Count | First step |",
    "| --- | --- | --- |",
    ...result.writes.map(
      (w) => `| ${code(w.endpoint, true)} | ${w.count} | ${w.firstStep} |`,
    ),
    "",
  ];
}

function receiptLines(result: ExploreRunResult): string[] {
  const { jev } = result;
  const latency = jev.latencyMs
    ? `, p50 ${jev.latencyMs.p50} ms, p95 ${jev.latencyMs.p95} ms`
    : "";
  return [
    "## Jev",
    "",
    `${jev.calls} calls, ${jev.inputTokens} input tokens, ${money(jev.costUsd)}${latency}.`,
    ...(jev.errors.length
      ? ["", "Failed calls (untrusted):", "", fence(jev.errors.join("\n"))]
      : []),
    "",
  ];
}

export function renderExploreMarkdown(
  result: ExploreRunResult,
  options: ExploreMarkdownOptions = {},
): string {
  const command = options.command ?? "sedum";
  const skipped = result.skipped.length
    ? [
        "## Not clicked",
        "",
        result.safety === "off"
          ? "Safety was off; these would have ended the session:"
          : `Safety was ${result.safety}; skipped as destructive or session-ending:`,
        "",
        ...result.skipped.map((name) => `- ${inline(name)}`),
        "",
      ]
    : [];
  return `${[
    `# Exploration of ${inline(result.startUrl)}`,
    "",
    verdict(result),
    "",
    ...summaryTable(result),
    "",
    "## Findings",
    "",
    ...(result.findings.length
      ? result.findings.flatMap((f) => findingSection(f, result, command))
      : ["None.", ""]),
    ...writeLines(result),
    ...coverageLines(result),
    ...skipped,
    ...receiptLines(result),
  ].join("\n")}\n`;
}
