import { randomUUID } from "node:crypto";
import {
  resultTotals,
  validateRunResult,
  type ResultAttempt,
  type ResultCall,
  type ResultStep,
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
      totals: resultTotals([]),
      setupCalls: [],
      tests: [],
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
      totals: resultTotals(this.value.tests, this.value.setupCalls),
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

  async startTest(input: {
    id: string;
    file: string;
    description?: string;
    tags?: readonly string[];
  }): Promise<void> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    const at = new Date().toISOString();
    const attempt: ResultAttempt = {
      id: `${input.id}:attempt:1`,
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
    this.value = { ...this.value, tests: [...this.value.tests, test] };
    await this.publish();
  }

  async addStep(step: ResultStep): Promise<void> {
    const test = this.value.tests.at(-1);
    const attempt = test?.attempts.at(-1);
    if (!test || !attempt || attempt.state !== "running")
      throw new Error("No running attempt");
    const updatedAttempt = { ...attempt, steps: [...attempt.steps, step] };
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

  /** Retry orchestration calls this only after a terminal whole-test attempt. */
  async startAttempt(): Promise<void> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    const test = this.value.tests.at(-1);
    if (!test || test.attempts.at(-1)?.state === "running")
      throw new Error("No terminal attempt to retry");
    const ordinal = test.attempts.length + 1;
    const at = new Date().toISOString();
    const attempt: ResultAttempt = {
      id: `${test.id}:attempt:${ordinal}`,
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
