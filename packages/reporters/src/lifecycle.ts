import { validateRunResult, type RunResult } from "@sedum-dev/core";

export type ReporterEvent =
  | { type: "runStarted"; result: RunResult }
  | { type: "testStarted"; test: RunResult["tests"][number] }
  | {
      type: "attemptStarted";
      test: RunResult["tests"][number];
      attempt: RunResult["tests"][number]["attempts"][number];
    }
  | {
      type: "stepCompleted";
      test: RunResult["tests"][number];
      attempt: RunResult["tests"][number]["attempts"][number];
      step: RunResult["tests"][number]["attempts"][number]["steps"][number];
    }
  | {
      type: "problemRecorded";
      test: RunResult["tests"][number];
      attempt: RunResult["tests"][number]["attempts"][number];
      problem: RunResult["tests"][number]["attempts"][number]["problems"][number];
    }
  | {
      type: "attemptCompleted";
      test: RunResult["tests"][number];
      attempt: RunResult["tests"][number]["attempts"][number];
    }
  | { type: "testCompleted"; test: RunResult["tests"][number] }
  | { type: "runCompleted"; result: RunResult };

/** Converts published snapshots to once-only lifecycle events. */
export class ReporterLifecycle {
  private started = false;
  private completed = false;
  private readonly tests = new Set<string>();
  private readonly attempts = new Set<string>();
  private readonly steps = new Set<string>();
  private readonly problems = new Set<string>();
  private readonly finishedAttempts = new Set<string>();
  private readonly finishedTests = new Set<string>();

  feed(snapshot: RunResult): ReporterEvent[] {
    const result = validateRunResult(snapshot);
    const events: ReporterEvent[] = [];
    if (!this.started) {
      this.started = true;
      events.push({ type: "runStarted", result });
    }
    for (const test of result.tests) {
      if (!this.tests.has(test.id)) {
        this.tests.add(test.id);
        events.push({ type: "testStarted", test });
      }
      for (const attempt of test.attempts) {
        if (!this.attempts.has(attempt.id)) {
          this.attempts.add(attempt.id);
          events.push({ type: "attemptStarted", test, attempt });
        }
        for (const step of attempt.steps) {
          if (this.steps.has(step.id)) continue;
          this.steps.add(step.id);
          events.push({ type: "stepCompleted", test, attempt, step });
        }
        for (const problem of attempt.problems) {
          if (this.problems.has(problem.id)) continue;
          this.problems.add(problem.id);
          events.push({ type: "problemRecorded", test, attempt, problem });
        }
        if (
          attempt.state !== "running" &&
          !this.finishedAttempts.has(attempt.id)
        ) {
          this.finishedAttempts.add(attempt.id);
          events.push({ type: "attemptCompleted", test, attempt });
        }
      }
      if (test.state !== "running" && !this.finishedTests.has(test.id)) {
        this.finishedTests.add(test.id);
        events.push({ type: "testCompleted", test });
      }
    }
    if (result.state !== "running" && !this.completed) {
      this.completed = true;
      events.push({ type: "runCompleted", result });
    }
    return events;
  }
}
