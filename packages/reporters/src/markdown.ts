import {
  validateRunResult,
  type ResultAttempt,
  type ResultProblem,
  type ResultStep,
  type ResultTest,
  type RunResult,
} from "@sedum-dev/core";
import {
  decisionLines,
  duration,
  needsAttention,
  score,
  selectedAttempt,
  shellArg,
  sourceStack,
  stepStatus,
  testOrder,
  testStatus,
  testStatusLabel,
} from "./shared.js";

/*
 * The run as one file a coding agent can be handed on its own. The first
 * screen answers "what broke and where"; the rest is there to be searched.
 * The file sits in the run directory, so `evidence/…` frame paths and the
 * sibling `result.json` and `report.html` resolve from it as written.
 *
 * Every string in the result came from a test file, a page, or the browser.
 * Inline text is escaped so it cannot open a heading, link, image, HTML tag
 * or table cell, and longer text goes in fences labeled as untrusted.
 */

/** One line of escaped inline text. */
function inline(value: string): string {
  return value
    .split(/\s+/u)
    .filter(Boolean)
    .join(" ")
    .replace(/[\\`*_[\]<>|!#~&]/g, (char) => "\\" + char);
}

/** An inline code span that survives backticks, and pipes inside a table cell. */
function code(value: string, cell = false): string {
  const text = value.split(/\s+/u).filter(Boolean).join(" ");
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const ticks = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return ticks + pad + (cell ? text.replace(/\|/g, "\\|") : text) + pad + ticks;
}

/** A fenced block one backtick longer than any backtick run inside it. */
function fence(text: string): string {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return ticks + "text\n" + text.replace(/\s+$/u, "") + "\n" + ticks;
}

function flags(values: readonly string[]): string {
  return values.length ? values.join(", ") : "—";
}

function holds(step: ResultStep): string {
  const judgement = step.judgement;
  if (!judgement) return "";
  const lines = decisionLines(judgement);
  return score(judgement.holds, lines ? [lines.fail, lines.pass] : []);
}

function problemFor(
  attempt: ResultAttempt,
  step: ResultStep,
): ResultProblem | undefined {
  return attempt.problems.find((problem) => problem.stepId === step.id);
}

function errorBlock(error: {
  code: string;
  message: string;
  callLog?: string[] | undefined;
}): string[] {
  return [
    fence(
      [`${error.code}: ${error.message}`, ...(error.callLog ?? [])].join("\n"),
    ),
  ];
}

function earlierAttempts(test: ResultTest): string | null {
  const earlier = test.attempts.filter(
    (attempt) => attempt.id !== test.selectedAttemptId,
  );
  if (!earlier.length) return null;
  return earlier
    .map((attempt) => {
      const primary =
        attempt.problems.find(
          (problem) => problem.id === attempt.primaryProblemId,
        )?.error.code ?? attempt.error?.code;
      return (
        `#${attempt.ordinal} ${attempt.verdict ?? attempt.state}` +
        (primary ? ` (${code(primary)})` : "")
      );
    })
    .join(", ");
}

function stepSection(
  number: number,
  test: ResultTest,
  attempt: ResultAttempt,
  step: ResultStep,
): string[] {
  const out = [
    `### ${number}. ${stepStatus(step)} · ${code(test.file)} · ${step.phase} step ${step.index} · ${step.kind}`,
    "",
    `> ${inline(step.sentence) || "(no sentence recorded)"}`,
    "",
    `- **status**: ${step.state}, verdict ${step.verdict ?? "none"}, flags ${flags(step.flags)}`,
    `- **where**: ${code(sourceStack(step.sourceStack))}`,
  ];
  if (step.detail) out.push(`- **result**: ${inline(step.detail)}`);
  const judgement = step.judgement;
  if (judgement) {
    const lines = decisionLines(judgement);
    out.push(
      step.kind === "measure"
        ? `- **judged**: holds ${holds(step)} — observation, no decision line`
        : `- **judged**: holds ${holds(step)} — ` +
            (lines
              ? `fails below ${score(lines.fail)}; passes at ${score(lines.pass)}; between them the step is flagged`
              : "decision lines unavailable"),
      `- **contradiction**: ${score(judgement.contradicted, [judgement.contradictionCutoff])} / cutoff ${score(judgement.contradictionCutoff)}`,
    );
  }
  out.push(
    step.page.status === "available"
      ? `- **page**: ${code(step.page.url)} — "${inline(step.page.title)}"`
      : `- **page**: ${step.page.status} (${inline(step.page.reason)})`,
  );
  const locator = step.locator;
  if (locator) {
    const cache = locator.cache
      ? ` · cache ${locator.cache.outcome}` +
        (locator.cache.reason ? ` (${inline(locator.cache.reason)})` : "") +
        (locator.cache.targetChanged ? ", target changed" : "")
      : "";
    out.push(
      `- **locator**: ${locator.source} · confidence ${score(locator.confidence)}${cache}`,
    );
    if (locator.options.length)
      for (const option of locator.options)
        out.push(
          `  - ${inline(option.label) || "(unlabeled)"}` +
            (option.role ? ` (${inline(option.role)})` : "") +
            `: ${score(option.probability)}`,
        );
    else out.push("  - no candidates weighed");
  }
  out.push(
    step.evidence.status === "captured"
      ? `- **frame**: ![step ${step.index} frame](${step.evidence.path}) ${code(step.evidence.path)}`
      : `- **frame**: ${step.evidence.status} (${inline(step.evidence.reason)})`,
  );
  out.push(`- **rerun**: ${code("sedum run " + shellArg(test.file))}`);
  if (test.attempts.length > 1) {
    out.push(
      `- **attempt**: ${attempt.ordinal} of ${test.attempts.length}; earlier ${earlierAttempts(test)}`,
    );
  }

  // A judged failure's reason is the scores above; its problem only repeats them.
  const problem = problemFor(attempt, step);
  const error = step.error ?? (judgement ? null : (problem?.error ?? null));
  if (error)
    out.push(
      "",
      "**Why it stopped** (browser error, untrusted)",
      "",
      ...errorBlock(error),
    );
  if (judgement?.judgedExcerpt)
    out.push(
      "",
      "**What the judge read** (page text, untrusted)",
      "",
      fence(judgement.judgedExcerpt),
    );
  out.push("");
  return out;
}

function problemSection(
  number: number,
  test: ResultTest,
  problem: ResultProblem,
): string[] {
  return [
    `### ${number}. ${problem.outcome} · ${code(test.file)} · ${problem.phase} module binding`,
    "",
    `- **where**: ${code(sourceStack(problem.sourceStack))}`,
    `- **rerun**: ${code("sedum run " + shellArg(test.file))}`,
    "",
    "**Why it stopped** (untrusted)",
    "",
    ...errorBlock(problem.error),
    "",
  ];
}

function attemptErrorSection(
  number: number,
  test: ResultTest,
  attempt: ResultAttempt,
): string[] {
  const out = [
    `### ${number}. ${attempt.state} · ${code(test.file)} · attempt ${attempt.ordinal}`,
    "",
  ];
  if (attempt.timeoutReason)
    out.push(`- **timeout**: ${inline(attempt.timeoutReason)}`);
  out.push(`- **rerun**: ${code("sedum run " + shellArg(test.file))}`);
  if (attempt.error)
    out.push(
      "",
      "**Why it stopped** (untrusted)",
      "",
      ...errorBlock(attempt.error),
    );
  out.push("");
  return out;
}

function stepTable(steps: readonly ResultStep[]): string[] {
  const out = [
    "| # | status | phase | step | score | time | detail |",
    "| ---: | --- | --- | --- | ---: | ---: | --- |",
  ];
  for (const step of steps) {
    const value = step.judgement
      ? `holds ${holds(step)}`
      : step.locator
        ? `confidence ${score(step.locator.confidence)}`
        : "";
    out.push(
      `| ${step.index} | ${stepStatus(step)} | ${step.phase} | ${inline(step.operation)}: ${inline(step.sentence)} | ${value} | ${duration(step.elapsedMs)} | ${inline(step.detail)} |`,
    );
  }
  return out;
}

function flowDetail(test: ResultTest): string[] {
  const attempt = selectedAttempt(test);
  const steps = attempt?.steps ?? [];
  const out = [
    `### ${testStatusLabel(test)} · ${code(test.file)}` +
      (test.description ? ` — ${inline(test.description)}` : ""),
    "",
  ];
  const facts = [
    `${steps.length} ${steps.length === 1 ? "step" : "steps"}`,
    attempt ? duration(attempt.elapsedMs) : null,
    test.tags.length ? `tags ${test.tags.map(inline).join(", ")}` : null,
  ].filter(Boolean);
  out.push(facts.join(" · "), "");
  const earlier = earlierAttempts(test);
  if (earlier) out.push(`Earlier attempts: ${earlier}`, "");
  if (!test.attempts.length) {
    out.push("This flow was selected but did not execute.", "");
    return out;
  }
  if (testStatus(test) === "passed") {
    const checks = steps.filter(
      (step) => step.kind === "verify" && step.judgement,
    );
    if (!checks.length) out.push("Passed; it has no checks to list.", "");
    else {
      out.push("Checks that held:", "");
      for (const step of checks) {
        const lines = decisionLines(step.judgement!);
        out.push(
          `- holds ${holds(step)}` +
            (lines ? ` (passes at ${score(lines.pass)})` : "") +
            ` — ${inline(step.sentence)}`,
        );
      }
      out.push("");
    }
    return out;
  }
  out.push(`Rerun: ${code("sedum run " + shellArg(test.file))}`, "");
  if (steps.length) out.push(...stepTable(steps), "");
  else out.push("No steps executed in the selected attempt.", "");
  return out;
}

function verdictLine(
  result: RunResult,
  counts: Record<string, number>,
): string {
  const verdict =
    result.state === "error" ||
    result.state === "interrupted" ||
    result.state === "running"
      ? result.state
      : counts.failed
        ? "failed"
        : counts.incomplete
          ? "incomplete"
          : counts.flagged
            ? "passed, flagged"
            : "passed";
  const parts = [
    `${counts.failed} failed`,
    `${counts.incomplete} incomplete`,
    `${counts.flagged} flagged`,
    `${counts.passed} passed`,
  ];
  const extra = [
    `${result.tests.length} ${result.tests.length === 1 ? "flow" : "flows"}`,
    result.totals.historicalAttempts
      ? `${result.totals.historicalAttempts} retried attempts`
      : null,
    `${result.totals.flaggedSteps} flagged steps`,
    duration(result.elapsedMs),
  ].filter(Boolean);
  return `**${verdict}** — ${parts.join(" · ")} (${extra.join(", ")})`;
}

/** Render one validated run as Markdown for a reader who has to fix it. */
export function renderMarkdown(input: RunResult): string {
  const result = validateRunResult(input);
  const tests = result.tests
    .map((test, index) => ({ test, index }))
    .sort((a, b) => testOrder(a.test) - testOrder(b.test) || a.index - b.index)
    .map(({ test }) => test);
  const counts: Record<string, number> = {
    failed: 0,
    incomplete: 0,
    flagged: 0,
    passed: 0,
  };
  for (const test of tests) counts[testStatus(test)]!++;

  const out = [
    "# Sedum run",
    "",
    verdictLine(result, counts),
    "",
    `- **run**: ${code(result.runId)}`,
    `- **started**: ${result.startedAt}`,
    "- **full record**: `result.json` in this folder; `report.html` is the visual report",
  ];
  if (result.error) {
    out.push(
      `- **run error**: ${code(result.error.code)} — ${inline(result.error.message)}`,
    );
  }
  out.push("");

  const attention = tests.map((test) => {
    const attempt = selectedAttempt(test);
    return {
      test,
      attempt,
      steps: attempt?.steps.filter(needsAttention) ?? [],
      bindings:
        attempt?.problems.filter((problem) => problem.stepId === null) ?? [],
      attemptError:
        attempt && (attempt.error || attempt.timeoutReason) ? attempt : null,
    };
  });

  out.push(
    "## Flows",
    "",
    "| status | flow | flags | steps passed | attempts | time | needs attention |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  );
  for (const item of attention) {
    const { test, attempt } = item;
    const steps = attempt?.steps ?? [];
    const count =
      item.steps.length + item.bindings.length + (item.attemptError ? 1 : 0);
    out.push(
      `| ${testStatusLabel(test)} | ${code(test.file, true)}` +
        (test.description ? ` ${inline(test.description)}` : "") +
        ` | ${flags(test.flags)} | ${steps.filter((step) => step.verdict === "passed").length}/${steps.length}` +
        ` | ${test.attempts.length} | ${attempt ? duration(attempt.elapsedMs) : "—"} | ${count || ""} |`,
    );
  }
  if (!tests.length) out.push("| — | no flows were recorded | | | | | |");
  out.push("");

  const discovery = result.discoveryProblems ?? [];
  if (discovery.length) {
    out.push(
      "## Test file problems",
      "",
      "These files did not run. Fix them first; the run exits 3 until they are valid.",
      "",
      "| where | code | problem | fix |",
      "| --- | --- | --- | --- |",
    );
    for (const problem of discovery)
      out.push(
        `| ${code(
          problem.file +
            (problem.line ? `:${problem.line}` : "") +
            (problem.line && problem.col ? `:${problem.col}` : ""),
          true,
        )} | ${code(problem.code, true)} | ${inline(problem.message)} | ${inline(problem.fix)} |`,
      );
    out.push("");
  }

  const sections: string[] = [];
  let number = 0;
  for (const item of attention) {
    if (!item.attempt) continue;
    for (const step of item.steps)
      sections.push(...stepSection(++number, item.test, item.attempt, step));
    for (const problem of item.bindings)
      sections.push(...problemSection(++number, item.test, problem));
    if (item.attemptError)
      sections.push(
        ...attemptErrorSection(++number, item.test, item.attemptError),
      );
  }
  if (sections.length) out.push("## Needs attention", "", ...sections);

  out.push("## Flow detail", "");
  for (const test of tests) out.push(...flowDetail(test));

  const reruns = [
    ...new Set(
      attention
        .filter(
          (item) =>
            item.steps.length ||
            item.bindings.length ||
            item.attemptError ||
            testStatus(item.test) !== "passed",
        )
        .map((item) => item.test.file),
    ),
  ];
  out.push("## Next steps", "");
  if (!sections.length && !discovery.length && !result.error)
    out.push("Nothing needs attention.");
  else {
    out.push(
      "1. Fix the items under **Needs attention** in order; the first is the most urgent.",
      "2. Open the linked frames to see the page at the moment each step stopped.",
      "3. Read `result.json` in this folder for every recorded field.",
    );
    if (reruns.length)
      out.push(
        `4. Rerun: ${code("sedum run " + reruns.map(shellArg).join(" "))}`,
      );
  }
  return out.join("\n") + "\n";
}
