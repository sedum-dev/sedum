import type {
  ResultAttempt,
  ResultStep,
  ResultTest,
  RunResult,
} from "@sedum-dev/core";

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
