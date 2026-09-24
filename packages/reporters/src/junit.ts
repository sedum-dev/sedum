import {
  validateRunResult,
  type ResultAttempt,
  type ResultStep,
  type ResultTest,
  type RunResult,
} from "@sedum-dev/core";
import {
  decisionLines,
  needsAttention,
  runIsTrustworthy,
  score,
  selectedAttempt,
  shellArg,
  sourceStack,
  stepStatus,
} from "./shared.js";

/*
 * JUnit XML for CI test views (GitLab, Jenkins, CircleCI, Azure DevOps and
 * JUnit actions on GitHub), shaped to validate against junit-10.xsd. Each
 * Sedum test file is one <testsuite> holding one <testcase>, because that
 * schema allows `file` and <properties> on a suite but not on a testcase.
 *
 * SED-13: a flagged pass is a passed testcase carrying its flags as metadata;
 * only --strict adds a failure. A leading "sedum run" suite carries run
 * totals, and a run testcase only when the exit code is 3 or a strict 2, so
 * the document and the exit code tell the same story.
 *
 * Every string in the result came from a test file, a page or the browser.
 * GitLab and the Jenkins attachments plugin treat `[[ATTACHMENT|path]]` in
 * output as a file to show, so no such marker may come from result text:
 * `[[` is split everywhere, and the renderer writes its own attachment lines.
 */

export interface JunitReportOptions {
  /** Whether the run was gated with --strict (SED-13). */
  readonly strict: boolean;
  /**
   * The run directory as a relative POSIX path from the directory the CI tool
   * resolves attachments against, or null to list no attachments.
   */
  readonly evidenceDirectory: string | null;
}

const MESSAGE_LIMIT = 512;

/** Replace characters XML 1.0 cannot carry, including lone surrogates. */
function xmlSafe(value: string): string {
  return value.replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, "�");
}

/** Leave no `[[` behind, so result text can never form an attachment marker. */
export function neutralizeMarkers(value: string): string {
  return value.replace(/\[(?=\[)/g, "[ ");
}

function escapeMarkup(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeText(value: string): string {
  return escapeMarkup(neutralizeMarkers(xmlSafe(value)));
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/** One line, cut to `limit` code points. */
function oneLine(value: string, limit = MESSAGE_LIMIT): string {
  const text = value.split(/\s+/u).filter(Boolean).join(" ");
  const points = [...text];
  return points.length > limit
    ? points.slice(0, limit - 1).join("") + "…"
    : text;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function attributes(values: Record<string, string | number>): string {
  return Object.entries(values)
    .map(([name, value]) => ` ${name}="${escapeAttribute(String(value))}"`)
    .join("");
}

function properties(values: readonly (readonly [string, string])[]): string {
  if (!values.length) return "";
  return (
    "    <properties>\n" +
    values
      .map(
        ([name, value]) => `      <property${attributes({ name, value })}/>\n`,
      )
      .join("") +
    "    </properties>\n"
  );
}

type Status = {
  readonly element: "failure" | "error" | "skipped";
  readonly type?: string;
  readonly message: string;
  readonly body: readonly string[];
};

interface Case {
  readonly classname: string;
  readonly name: string;
  readonly time: number;
  readonly status: Status | null;
  readonly output: readonly string[];
  readonly attachments: readonly string[];
}

function renderCase(testcase: Case): string {
  const open = `    <testcase${attributes({
    classname: testcase.classname,
    name: testcase.name,
    time: seconds(testcase.time),
  })}`;
  const status = testcase.status;
  const children: string[] = [];
  if (status) {
    const head = `      <${status.element}${attributes({
      ...(status.type ? { type: status.type } : {}),
      message: oneLine(status.message),
    })}`;
    children.push(
      status.body.length
        ? `${head}>${escapeText(status.body.join("\n"))}</${status.element}>\n`
        : `${head}/>\n`,
    );
  }
  if (testcase.output.length || testcase.attachments.length) {
    // Attachment lines are the only unescaped-marker text in the document.
    const lines = [
      ...testcase.output.map(escapeText),
      ...testcase.attachments.map(
        (item) => `[[ATTACHMENT|${escapeMarkup(xmlSafe(item))}]]`,
      ),
    ];
    children.push(`      <system-out>${lines.join("\n")}</system-out>\n`);
  }
  return children.length
    ? `${open}>\n${children.join("")}    </testcase>\n`
    : `${open}/>\n`;
}

interface Suite {
  readonly name: string;
  readonly file?: string;
  readonly time: number;
  readonly timestamp: string;
  readonly properties: readonly (readonly [string, string])[];
  readonly cases: readonly Case[];
}

function counts(cases: readonly Case[]) {
  const of = (element: Status["element"]) =>
    cases.filter((item) => item.status?.element === element).length;
  return {
    tests: cases.length,
    failures: of("failure"),
    errors: of("error"),
    skipped: of("skipped"),
  };
}

function renderSuite(suite: Suite): string {
  const total = counts(suite.cases);
  return (
    `  <testsuite${attributes({
      name: suite.name,
      tests: total.tests,
      failures: total.failures,
      errors: total.errors,
      skipped: total.skipped,
      time: seconds(suite.time),
      timestamp: suite.timestamp,
      ...(suite.file ? { file: suite.file } : {}),
    })}>\n` +
    properties(suite.properties) +
    suite.cases.map(renderCase).join("") +
    "  </testsuite>\n"
  );
}

function flagCounts(
  result: RunResult,
): Record<"low_confidence" | "contradiction", number> {
  const total = { low_confidence: 0, contradiction: 0 };
  for (const test of result.tests)
    for (const step of selectedAttempt(test)?.steps ?? [])
      for (const flag of step.flags) total[flag] += 1;
  return total;
}

function flagSummary(
  counted: Record<"low_confidence" | "contradiction", number>,
): string {
  return `low_confidence ${counted.low_confidence}, contradiction ${counted.contradiction}`;
}

function frameLine(
  frame: ResultStep["evidence"],
  evidenceDirectory: string | null,
): string {
  if (frame.status !== "captured")
    return `frame: ${frame.status} (${frame.reason})`;
  return `frame: ${evidenceDirectory ? `${evidenceDirectory}/` : ""}${frame.path}`;
}

function stepLines(
  attempt: ResultAttempt,
  step: ResultStep,
  evidenceDirectory: string | null,
): string[] {
  const out = [
    `${stepStatus(step)} — ${step.phase} step ${step.index} (${step.kind}): ${oneLine(step.sentence) || "(no sentence recorded)"}`,
    `  where: ${sourceStack(step.sourceStack)}`,
  ];
  if (step.detail) out.push(`  result: ${oneLine(step.detail)}`);
  const judgement = step.judgement;
  if (judgement) {
    const lines = decisionLines(judgement);
    const holds = score(judgement.holds, lines ? [lines.fail, lines.pass] : []);
    out.push(
      step.kind === "measure"
        ? `  holds ${holds} — observation, no decision line`
        : `  holds ${holds} — ` +
            (lines
              ? `fails below ${score(lines.fail)}; passes at ${score(lines.pass)}`
              : "decision lines unavailable"),
      `  contradiction ${score(judgement.contradicted, [judgement.contradictionCutoff])} / cutoff ${score(judgement.contradictionCutoff)}`,
    );
  }
  out.push(
    step.page.status === "available"
      ? `  page: ${step.page.url} "${oneLine(step.page.title)}"`
      : `  page: ${step.page.status} (${step.page.reason})`,
  );
  // A judged failure's reason is the scores above; its problem only repeats them.
  const problem = attempt.problems.find((item) => item.stepId === step.id);
  const error = step.error ?? (judgement ? null : (problem?.error ?? null));
  if (error) {
    out.push(`  error: ${error.code}: ${oneLine(error.message)}`);
    for (const line of error.callLog ?? []) out.push(`    ${line}`);
  }
  if (judgement?.judgedExcerpt) {
    out.push("  judged page text (untrusted):");
    for (const line of judgement.judgedExcerpt.split(/\r?\n/u))
      out.push(`    ${line}`);
  }
  out.push(`  ${frameLine(step.evidence, evidenceDirectory)}`);
  return out;
}

function earlierAttempts(test: ResultTest): string | null {
  if (test.attempts.length < 2) return null;
  return (
    "attempts: " +
    test.attempts
      .map((attempt) => {
        const primary =
          attempt.problems.find((item) => item.id === attempt.primaryProblemId)
            ?.error.code ?? attempt.error?.code;
        return (
          `#${attempt.ordinal} ${attempt.verdict ?? attempt.state}` +
          (primary ? ` (${primary})` : "")
        );
      })
      .join(", ")
  );
}

/** What went wrong in the selected attempt, for a failure or error body. */
function attentionLines(
  test: ResultTest,
  attempt: ResultAttempt,
  evidenceDirectory: string | null,
): string[] {
  const out = attempt.steps
    .filter(needsAttention)
    .flatMap((step) => stepLines(attempt, step, evidenceDirectory));
  for (const problem of attempt.problems.filter(
    (item) => item.origin === "module_binding",
  ))
    out.push(
      `module binding problem — ${problem.phase}: ${problem.error.code}: ${oneLine(problem.error.message)}`,
      `  where: ${sourceStack(problem.sourceStack)}`,
    );
  if (attempt.error && !attempt.problems.length)
    out.push(
      `attempt error: ${attempt.error.code}: ${oneLine(attempt.error.message)}`,
    );
  if (attempt.timeoutReason) out.push(`timeout: ${attempt.timeoutReason}`);
  const history = earlierAttempts(test);
  if (history) out.push(history);
  out.push(`rerun: sedum run ${shellArg(test.file)}`);
  return out;
}

function testStatusElement(
  test: ResultTest,
  attempt: ResultAttempt | undefined,
  result: RunResult,
  strict: boolean,
  evidenceDirectory: string | null,
): Status | null {
  if (!attempt)
    return {
      element: "skipped",
      message: `not executed: run ${result.state}`,
      body: [],
    };
  const body = () => attentionLines(test, attempt, evidenceDirectory);
  const primary = attempt.problems.find(
    (item) => item.id === attempt.primaryProblemId,
  );
  if (test.verdict === "failed") {
    const step = attempt.steps.find((item) => item.id === primary?.stepId);
    return {
      element: "failure",
      type: primary?.error.code ?? "failed",
      message: step
        ? `${step.phase} step ${step.index} failed: ${step.sentence}`
        : primary
          ? `${primary.phase} ${primary.error.code}: ${primary.error.message}`
          : "failed",
      body: body(),
    };
  }
  if (test.verdict === null)
    return {
      element: "error",
      type:
        primary?.error.code ??
        attempt.error?.code ??
        (attempt.timeoutReason ? "timeout" : attempt.state),
      message:
        primary?.error.message ??
        attempt.error?.message ??
        attempt.timeoutReason ??
        `${attempt.state} before a verdict`,
      body: body(),
    };
  if (strict && test.flags.length)
    return {
      element: "failure",
      type: "sedum.flagged",
      message: `passed with flags: ${test.flags.join(", ")} (--strict)`,
      body: body(),
    };
  return null;
}

function testSuite(
  test: ResultTest,
  result: RunResult,
  options: JunitReportOptions,
): Suite {
  const attempt = selectedAttempt(test);
  const status = testStatusElement(
    test,
    attempt,
    result,
    options.strict,
    options.evidenceDirectory,
  );
  const output: string[] = [];
  if (test.flags.length && attempt) {
    const stepFlags = { low_confidence: 0, contradiction: 0 };
    for (const step of attempt.steps)
      for (const flag of step.flags) stepFlags[flag] += 1;
    output.push(`flags: ${flagSummary(stepFlags)} (flagged steps)`);
  }
  // In default mode a flagged pass has no failure to carry its diagnostics;
  // they include the attempt history, which otherwise stands alone.
  if (!status && test.flags.length && attempt)
    output.push(...attentionLines(test, attempt, options.evidenceDirectory));
  else {
    const history = earlierAttempts(test);
    if (history) output.push(history);
  }
  const attachments =
    attempt && options.evidenceDirectory
      ? attempt.steps
          .filter(needsAttention)
          .flatMap((step) =>
            step.evidence.status === "captured"
              ? [`${options.evidenceDirectory}/${step.evidence.path}`]
              : [],
          )
      : [];
  const elapsed = test.attempts.reduce((sum, item) => sum + item.elapsedMs, 0);
  const description = oneLine(test.description);
  return {
    name: test.file,
    file: test.file,
    time: elapsed,
    timestamp: test.attempts[0]?.startedAt ?? result.startedAt,
    properties: [
      ["sedum.run_id", result.runId],
      ["sedum.test_id", test.id],
      ["sedum.verdict", test.verdict ?? "none"],
      ...(test.state === "completed"
        ? []
        : [["sedum.state", test.state] as const]),
      ...(test.flags.length
        ? [["sedum.flags", test.flags.join(",")] as const]
        : []),
      ...(test.tags.length
        ? [["sedum.tags", test.tags.join(",")] as const]
        : []),
      ["sedum.attempts", String(test.attempts.length)],
      ["sedum.strict", String(options.strict)],
    ],
    cases: [
      {
        classname: test.file,
        name: description || test.file,
        time: elapsed,
        status,
        output,
        attachments,
      },
    ],
  };
}

function runSuite(result: RunResult, strict: boolean): Suite {
  const flags = flagCounts(result);
  const flagged = flags.low_confidence + flags.contradiction > 0;
  const selected = result.selectedTestCount ?? result.tests.length;
  let status: Status | null = null;
  if (!runIsTrustworthy(result)) {
    const body = [...(result.error?.callLog ?? [])];
    if (selected > result.tests.length)
      body.push(
        `${selected - result.tests.length} of ${selected} selected tests did not start`,
      );
    if (flagged) body.push(`flags: ${flagSummary(flags)} (flagged steps)`);
    status = {
      element: "error",
      type: result.error?.code ?? result.state,
      message:
        result.error?.message ??
        (result.totals.executedTests === 0
          ? "no tests were executed"
          : `run ${result.state} without a verdict`),
      body,
    };
  } else if (strict && result.verdict === "passed" && result.flags.length)
    status = {
      element: "failure",
      type: "sedum.flagged",
      message: `passed with flags: ${flagSummary(flags)} (--strict)`,
      body: [],
    };
  return {
    name: "sedum run",
    time: result.elapsedMs,
    timestamp: result.startedAt,
    properties: [
      ["sedum.run_id", result.runId],
      ["sedum.state", result.state],
      ["sedum.verdict", result.verdict ?? "none"],
      ["sedum.strict", String(strict)],
      ["sedum.tests.selected", String(selected)],
      ["sedum.tests.passed", String(result.totals.passedTests)],
      ["sedum.tests.failed", String(result.totals.failedTests)],
      ["sedum.flagged_steps", String(result.totals.flaggedSteps)],
      ["sedum.flags.low_confidence", String(flags.low_confidence)],
      ["sedum.flags.contradiction", String(flags.contradiction)],
    ],
    cases: status
      ? [
          {
            classname: "sedum",
            name: "run",
            time: result.elapsedMs,
            status,
            output: [],
            attachments: [],
          },
        ]
      : [],
  };
}

function discoverySuite(result: RunResult): Suite | null {
  const problems = result.discoveryProblems ?? [];
  if (!problems.length) return null;
  return {
    name: "discovery",
    time: 0,
    timestamp: result.startedAt,
    properties: [],
    cases: problems.map((problem) => ({
      classname: problem.file,
      name:
        problem.file +
        (problem.line === undefined
          ? ""
          : `:${problem.line}:${problem.col ?? 1}`) +
        ` ${problem.code}`,
      time: 0,
      status: {
        element: "error",
        type: problem.code,
        message: problem.message,
        body: [`Fix: ${problem.fix}`],
      },
      output: [],
      attachments: [],
    })),
  };
}

function checkEvidenceDirectory(value: string | null): void {
  if (value === null) return;
  if (
    !value ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    [...value].some(
      (char) => "\\[]|".includes(char) || char.charCodeAt(0) < 0x20,
    ) ||
    value.split("/").some((segment) => segment === ".." || segment === "")
  )
    throw new Error(
      "JUnit evidence directory must be a relative POSIX path without '..'",
    );
}

/** JUnit XML for one validated run; the same input always gives the same bytes. */
export function renderJunit(
  input: RunResult,
  options: JunitReportOptions,
): string {
  const result = validateRunResult(input);
  checkEvidenceDirectory(options.evidenceDirectory);
  const discovery = discoverySuite(result);
  const suites = [
    runSuite(result, options.strict),
    ...(discovery ? [discovery] : []),
    ...result.tests.map((test) => testSuite(test, result, options)),
  ];
  const all = counts(suites.flatMap((suite) => suite.cases));
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites${attributes({
      name: "sedum",
      tests: all.tests,
      failures: all.failures,
      errors: all.errors,
      time: seconds(result.elapsedMs),
    })}>\n` +
    suites.map(renderSuite).join("") +
    "</testsuites>\n"
  );
}
