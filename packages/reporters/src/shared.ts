import type {
  ResultCall,
  ResultAttempt,
  ResultStep,
  ResultTest,
  RunResult,
} from "@sedum-dev/core";

/** Raw text; each renderer escapes it for its output format. */
export function visionSummary(step: ResultStep): string | null {
  const vision = step.locator?.vision;
  if (!vision) return null;
  const models = [
    ...new Set(
      step.calls.filter((c) => c.modality === "vision").map((c) => c.model),
    ),
  ];
  return (
    `Vision fallback: ${vision.outcome ?? (vision.failure ? "failed" : "outcome unrecorded")} · ${models.join(", ") || "model unrecorded"} · ${Math.round(vision.elapsedMs)} ms` +
    (vision.reason ? ` · trigger: ${vision.reason}` : "") +
    (vision.abstentionReason
      ? ` · abstention: ${vision.abstentionReason}`
      : "") +
    (vision.failure ? ` · ${vision.failure}` : "") +
    (vision.httpStatus ? ` · HTTP ${vision.httpStatus}` : "")
  );
}

export function usageLines(result: RunResult): string[] {
  const steps = result.tests.flatMap((t) => t.attempts.flatMap((a) => a.steps));
  const all = [
    ...result.setupCalls,
    ...result.tests.flatMap((t) =>
      t.attempts.flatMap((a) => [
        ...(a.calls ?? []),
        ...a.steps.flatMap((s) => s.calls),
      ]),
    ),
  ];
  const line = (label: string, calls: ResultCall[]) => {
    const known = calls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
    const unknown = calls.filter((c) => c.costUsd === null).length;
    return `${label}: ${calls.reduce((sum, c) => sum + c.attempts, 0)} calls · ${calls.reduce((sum, c) => sum + c.inputTokens, 0)} input tokens · ${calls.reduce((sum, c) => sum + c.outputTokens, 0)} output tokens · ${unknown ? "known subtotal" : "recorded cost"} $${known.toFixed(6)}${unknown ? `; ${unknown} ${unknown === 1 ? "call" : "calls"} with unknown cost` : ""}`;
  };
  const vision = all.filter((c) => c.modality === "vision");
  const lines = [
    line(
      "Text models",
      all.filter((c) => c.modality !== "vision"),
    ),
  ];
  if (vision.length) {
    lines.push(line("Vision models", vision));
    const outcomes = steps
      .map((s) => s.locator?.vision)
      .filter((v) => v !== undefined);
    lines.push(
      `Vision outcomes: ${outcomes.filter((v) => v.outcome === "selected").length} selected · ${outcomes.filter((v) => v.outcome === "abstained").length} abstained · ${outcomes.filter((v) => v.outcome === "failed" || (!v.outcome && v.failure)).length} failed`,
    );
  }
  // With text models only, the total would repeat the line above.
  if (vision.length) lines.push(line("All models (all attempts)", all));
  return lines;
}

/** How a test reads in a report, from most to least urgent. */
export type TestStatus = "failed" | "incomplete" | "flagged" | "passed";

export function selectedAttempt(test: ResultTest): ResultAttempt | undefined {
  return test.attempts.find((attempt) => attempt.id === test.selectedAttemptId);
}

export function testStatus(test: ResultTest): TestStatus {
  if (test.verdict === "failed") return "failed";
  if (test.verdict === null) return "incomplete";
  if (test.flags.length) return "flagged";
  return "passed";
}

export function testStatusLabel(test: ResultTest): string {
  const value = testStatus(test);
  return value === "flagged" ? "passed, flagged" : value;
}

/**
 * Failed first, then tests that never reached a verdict, then flagged passes.
 * An incomplete test says nothing about the app yet, so it outranks a pass.
 */
export function testOrder(test: ResultTest): number {
  return { failed: 0, incomplete: 1, flagged: 2, passed: 3 }[testStatus(test)];
}

/**
 * Whether a run produced a verdict CI can trust. When it did not, SED-13's
 * exit is 3 whatever the tests said; the JUnit run testcase uses the same rule.
 */
export function runIsTrustworthy(result: RunResult): boolean {
  return (
    result.state === "completed" &&
    result.error === null &&
    result.verdict !== null &&
    result.totals.executedTests > 0
  );
}

export function stepStatus(step: ResultStep): string {
  if (step.state === "error" || step.state === "interrupted") return step.state;
  if (step.verdict === "failed") return "failed";
  if (step.state === "running") return "running";
  if (step.flags.length) return "passed, flagged";
  return step.verdict ?? "measured";
}

/** The steps every reporter calls out: failures, errors, interruptions, flags. */
export function needsAttention(step: ResultStep): boolean {
  return (
    step.verdict === "failed" ||
    step.state === "error" ||
    step.state === "interrupted" ||
    step.flags.length > 0
  );
}

/** A verify step fails below `fail` and passes at `pass`; between them it is flagged. */
export function decisionLines(
  judgement: NonNullable<ResultStep["judgement"]>,
): { fail: number; pass: number } | null {
  if (judgement.threshold === null || judgement.band === null) return null;
  return {
    fail: Math.max(0, judgement.threshold - judgement.band),
    pass: judgement.threshold,
  };
}

/**
 * Two decimals, unless rounding would make `value` look equal to, or on the
 * wrong side of, a line it is compared with. Then it gets the digits it needs.
 */
export function score(
  value: number | null,
  against: readonly (number | null)[] = [],
): string {
  if (value === null) return "unavailable";
  const lines = against.filter(
    (line): line is number => line !== null && line !== value,
  );
  for (let digits = 2; digits <= 6; digits++) {
    const shown = value.toFixed(digits);
    // Lines themselves are printed with two decimals.
    const honest = lines.every(
      (line) =>
        Math.sign(Number(shown) - Number(line.toFixed(2))) ===
        Math.sign(value - line),
    );
    if (honest) return shown;
  }
  return String(value);
}

export function duration(ms: number): string {
  return ms >= 1000
    ? (ms / 1000).toFixed(ms >= 10000 ? 1 : 2) + "s"
    : Math.round(ms) + "ms";
}

export function sourceStack(
  stack: readonly { file: string; line: number; col: number }[],
): string {
  return stack.map((s) => s.file + ":" + s.line + ":" + s.col).join(" → ");
}

export function shellArg(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** A `*.test.ts` file can declare several tests; its title tells them apart. */
function isScriptTest(test: Pick<ResultTest, "file">): boolean {
  return test.file.endsWith(".test.ts");
}

/** How a test is named in reports: its file, plus its title for `*.test.ts`. */
export function testLabel(
  test: Pick<ResultTest, "file" | "description">,
): string {
  return isScriptTest(test) && test.description
    ? `${test.file} › ${test.description}`
    : test.file;
}

/** Arguments to `sedum run` that select exactly this test. */
export function rerunArgs(test: Pick<ResultTest, "file" | "id">): string {
  return isScriptTest(test)
    ? `${shellArg(test.file)} --id ${shellArg(test.id)}`
    : shellArg(test.file);
}

/** A step's sentence under its `ai.group` names, outermost first. */
export function stepText(
  step: Pick<ResultStep, "sentence" | "group" | "goal">,
): string {
  const text = step.goal?.text ?? step.sentence;
  return step.group?.length ? `${step.group.join(" › ")} › ${text}` : text;
}
