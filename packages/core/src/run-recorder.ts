import { randomUUID } from "node:crypto";
import {
  resultTotals,
  validateRunResult,
  type ResultAttempt,
  type ResultCall,
  type ResultStep,
  type ResultProblem,
  type ResultTest,
  type RunResult,
} from "./run-result.js";

export type ResultSink = (snapshot: RunResult) => Promise<void>;

/** One run owns the mutable journal; each published value is a validated copy. */
export class RunRecorder {
  private readonly started = performance.now();
  private value: RunResult;

  constructor(
    private readonly sink: ResultSink,
    runId: string = randomUUID(),
  ) {
    const at = new Date().toISOString();
    this.value = {
      schemaVersion: 1,
      runId,
      state: "running",
      verdict: null,
      flags: [],
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      elapsedMs: 0,
      selectedTestCount: 0,
      totals: resultTotals([]),
      setupCalls: [],
      tests: [],
      discoveryProblems: [],
      error: null,
    };
  }

  get runId(): string {
    return this.value.runId;
  }
  get snapshot(): RunResult {
    return structuredClone(this.value);
  }

  private async publish(): Promise<void> {
    this.value = {
      ...this.value,
      updatedAt: new Date().toISOString(),
      elapsedMs: performance.now() - this.started,
      totals: resultTotals(
        this.value.tests,
        this.value.setupCalls,
        Math.max(this.value.selectedTestCount ?? 0, this.value.tests.length),
      ),
      flags: [
        ...new Set(this.value.tests.flatMap((test) => test.flags)),
      ] as RunResult["flags"],
    };
    await this.sink(validateRunResult(this.value));
  }

  async start(): Promise<void> {
    await this.publish();
  }

  async addSetupCalls(calls: readonly ResultCall[]): Promise<void> {
    this.value = {
      ...this.value,
      setupCalls: [...this.value.setupCalls, ...calls],
    };
    await this.publish();
  }

  async addAttemptCalls(calls: readonly ResultCall[]): Promise<void> {
    const test = this.value.tests.at(-1);
    const attempt = test?.attempts.at(-1);
    if (!test || !attempt || attempt.state !== "running")
      throw new Error("No running attempt");
    const updated: ResultAttempt = {
      ...attempt,
      calls: [...(attempt.calls ?? []), ...calls],
    };
    this.value = {
      ...this.value,
      tests: [
        ...this.value.tests.slice(0, -1),
        { ...test, attempts: [...test.attempts.slice(0, -1), updated] },
      ],
    };
    await this.publish();
  }

  async addDiscoveryProblems(
    problems: NonNullable<RunResult["discoveryProblems"]>,
  ): Promise<void> {
    this.value = {
      ...this.value,
      discoveryProblems: [...(this.value.discoveryProblems ?? []), ...problems],
    };
    await this.publish();
  }

  async selectTests(count: number): Promise<void> {
    if (!Number.isSafeInteger(count) || count < this.value.tests.length)
      throw new Error("Selected test count is invalid");
    this.value = { ...this.value, selectedTestCount: count };
    await this.publish();
  }

  async startTest(input: {
    id: string;
    file: string;
    description?: string;
    tags?: readonly string[];
  }): Promise<void> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    const at = new Date().toISOString();
    const attempt: ResultAttempt = {
      id: `${this.value.runId}:attempt:${randomUUID()}`,
      ordinal: 1,
      state: "running",
      verdict: null,
      flags: [],
      startedAt: at,
      finishedAt: null,
      elapsedMs: 0,
      timeoutReason: null,
      error: null,
      steps: [],
      calls: [],
      problems: [],
      primaryProblemId: null,
    };
    const test: ResultTest = {
      id: input.id,
      file: input.file,
      description: input.description ?? "",
      tags: [...(input.tags ?? [])],
      state: "running",
      verdict: null,
      flags: [],
      selectedAttemptId: attempt.id,
      attempts: [attempt],
    };
    this.value = {
      ...this.value,
      tests: [...this.value.tests, test],
      selectedTestCount: Math.max(
        this.value.selectedTestCount ?? 0,
        this.value.tests.length + 1,
      ),
    };
    await this.publish();
  }

  async addStep(step: ResultStep): Promise<void> {
    const test = this.value.tests.at(-1);
    const attempt = test?.attempts.at(-1);
    if (!test || !attempt || attempt.state !== "running")
      throw new Error("No running attempt");
    const problem: ResultProblem | null =
      step.state === "error" || step.verdict === "failed"
        ? {
            id: `${attempt.id}:problem:${attempt.problems.length + 1}`,
            ordinal: attempt.problems.length + 1,
            origin: "step",
            outcome: step.state === "error" ? "error" : "failed",
            phase: step.phase,
            sourceStack: step.sourceStack,
            stepId: step.id,
            error: step.error ?? {
              code: step.state === "error" ? "step_error" : "step_failed",
              message:
                step.state === "error"
                  ? "The step could not complete."
                  : "The step failed.",
            },
          }
        : null;
    const updatedAttempt = {
      ...attempt,
      steps: [...attempt.steps, step],
      problems: problem ? [...attempt.problems, problem] : attempt.problems,
      primaryProblemId: attempt.primaryProblemId ?? problem?.id ?? null,
    };
    const updatedTest = {
      ...test,
      attempts: [...test.attempts.slice(0, -1), updatedAttempt],
    };
    this.value = {
      ...this.value,
      tests: [...this.value.tests.slice(0, -1), updatedTest],
    };
    await this.publish();
  }

  async addProblem(
    input: Pick<
      ResultProblem,
      "origin" | "outcome" | "phase" | "sourceStack" | "stepId" | "error"
    >,
  ): Promise<void> {
    const test = this.value.tests.at(-1);
    const attempt = test?.attempts.at(-1);
    if (!test || !attempt || attempt.state !== "running")
      throw new Error("No running attempt");
    const problem: ResultProblem = {
      ...input,
      id: `${attempt.id}:problem:${attempt.problems.length + 1}`,
      ordinal: attempt.problems.length + 1,
    };
    const updatedAttempt: ResultAttempt = {
      ...attempt,
      problems: [...attempt.problems, problem],
      primaryProblemId: attempt.primaryProblemId ?? problem.id,
    };
    this.value = {
      ...this.value,
      tests: [
        ...this.value.tests.slice(0, -1),
        { ...test, attempts: [...test.attempts.slice(0, -1), updatedAttempt] },
      ],
    };
    await this.publish();
  }

  /** Retry orchestration calls this only after a terminal whole-test attempt. */
  async startAttempt(): Promise<void> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    const test = this.value.tests.at(-1);
    if (!test || test.attempts.at(-1)?.state === "running")
      throw new Error("No terminal attempt to retry");
    const ordinal = test.attempts.length + 1;
    const at = new Date().toISOString();
    const attempt: ResultAttempt = {
      id: `${this.value.runId}:attempt:${randomUUID()}`,
      ordinal,
      state: "running",
      verdict: null,
      flags: [],
      startedAt: at,
      finishedAt: null,
      elapsedMs: 0,
      timeoutReason: null,
      error: null,
      steps: [],
      calls: [],
      problems: [],
      primaryProblemId: null,
    };
    const updatedTest: ResultTest = {
      ...test,
      state: "running",
      verdict: null,
      flags: [],
      selectedAttemptId: attempt.id,
      attempts: [...test.attempts, attempt],
    };
    this.value = {
      ...this.value,
      tests: [...this.value.tests.slice(0, -1), updatedTest],
    };
    await this.publish();
  }

  async finishTest(verdict: "passed" | "failed"): Promise<void> {
    const test = this.value.tests.at(-1);
    const attempt = test?.attempts.at(-1);
    if (!test || !attempt) throw new Error("No test to finish");
    const flags = [
      ...new Set(attempt.steps.flatMap((step) => step.flags)),
    ] as ResultAttempt["flags"];
    const finished = new Date().toISOString();
    const updatedAttempt: ResultAttempt = {
      ...attempt,
      state: "completed",
      verdict,
      flags,
      finishedAt: finished,
      elapsedMs: Math.max(
        0,
        Date.parse(finished) - Date.parse(attempt.startedAt),
      ),
    };
    const updatedTest: ResultTest = {
      ...test,
      state: "completed",
      verdict,
      flags,
      attempts: [...test.attempts.slice(0, -1), updatedAttempt],
    };
    this.value = {
      ...this.value,
      tests: [...this.value.tests.slice(0, -1), updatedTest],
    };
    await this.publish();
  }

  async finish(
    error: RunResult["error"] = null,
    terminalState: "error" | "interrupted" = "error",
  ): Promise<void> {
    const at = new Date().toISOString();
    if (!error && this.value.tests.length === 0)
      error = { code: "no_tests", message: "No tests were executed." };
    if (error) {
      const test = this.value.tests.at(-1);
      const attempt = test?.attempts.at(-1);
      if (test && attempt?.state === "running") {
        const updatedAttempt: ResultAttempt = {
          ...attempt,
          state: terminalState,
          error,
          timeoutReason:
            error.code === "run_timeout"
              ? "run_timeout"
              : attempt.timeoutReason,
          finishedAt: at,
          elapsedMs: Math.max(
            0,
            Date.parse(at) - Date.parse(attempt.startedAt),
          ),
        };
        const updatedTest: ResultTest = {
          ...test,
          state: terminalState,
          attempts: [...test.attempts.slice(0, -1), updatedAttempt],
        };
        this.value = {
          ...this.value,
          tests: [...this.value.tests.slice(0, -1), updatedTest],
        };
      }
    }
    const tests = this.value.tests;
    const verdict =
      error || tests.length === 0 || tests.some((test) => test.verdict === null)
        ? null
        : tests.some((test) => test.verdict === "failed")
          ? "failed"
          : "passed";
    this.value = {
      ...this.value,
      state: error ? terminalState : "completed",
      error,
      verdict,
      flags: [
        ...new Set(tests.flatMap((test) => test.flags)),
      ] as RunResult["flags"],
      finishedAt: at,
    };
    await this.publish();
  }
}
