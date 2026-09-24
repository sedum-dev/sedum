import { randomUUID } from "node:crypto";
import {
  resultTotals,
  validateRunResult,
  type ResultAttempt,
  type ResultCall,
  type ResultExecution,
  type ResultStep,
  type ResultProblem,
  type ResultTest,
  type RunResult,
} from "./run-result.js";

export type ResultSink = (snapshot: RunResult) => Promise<void>;

export interface TestStartInput {
  readonly id: string;
  readonly file: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** Selection position; `tests[]` stays in this order whatever finishes first. */
  readonly ordinal?: number;
  /** Zero-based parallel lane running the first attempt. */
  readonly lane?: number;
}

type ProblemInput = Pick<
  ResultProblem,
  "origin" | "outcome" | "phase" | "sourceStack" | "stepId" | "error"
>;

/**
 * One test's view of the run journal. Every mutation is bound to this test's
 * id, so concurrently running tests never write into each other.
 */
export class TestRecording {
  constructor(
    private readonly recorder: RunRecorder,
    readonly testId: string,
    readonly ordinal: number,
  ) {}

  /** The test as last recorded. */
  get test(): ResultTest {
    return this.recorder.testById(this.testId);
  }

  get file(): string {
    return this.test.file;
  }

  /** The newest attempt, or null before any attempt exists. */
  get currentAttempt(): {
    readonly id: string;
    readonly ordinal: number;
    readonly running: boolean;
    readonly stepCount: number;
  } | null {
    const attempt = this.test.attempts.at(-1);
    return attempt
      ? {
          id: attempt.id,
          ordinal: attempt.ordinal,
          running: attempt.state === "running",
          stepCount: attempt.steps.length,
        }
      : null;
  }

  startAttempt(lane?: number): Promise<void> {
    return this.recorder.startAttemptFor(this.testId, lane);
  }
  addStep(step: ResultStep): Promise<void> {
    return this.recorder.addStepFor(this.testId, step);
  }
  addProblem(input: ProblemInput): Promise<void> {
    return this.recorder.addProblemFor(this.testId, input);
  }
  addAttemptCalls(calls: readonly ResultCall[]): Promise<void> {
    return this.recorder.addAttemptCallsFor(this.testId, calls);
  }
  finishTest(verdict: "passed" | "failed"): Promise<void> {
    return this.recorder.finishTestFor(this.testId, verdict);
  }
}

function newAttempt(
  runId: string,
  ordinal: number,
  lane: number | undefined,
): ResultAttempt {
  return {
    id: `${runId}:attempt:${randomUUID()}`,
    ordinal,
    state: "running",
    verdict: null,
    flags: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    ...(lane === undefined ? {} : { lane }),
    timeoutReason: null,
    error: null,
    steps: [],
    calls: [],
    problems: [],
    primaryProblemId: null,
  };
}

/** One run owns the mutable journal; each published value is a validated copy. */
export class RunRecorder {
  private readonly started = performance.now();
  private value: RunResult;
  private readonly ordinals = new Map<string, number>();
  private lastTestId: string | null = null;

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

  /** @internal Handles read their test through here. */
  testById(testId: string): ResultTest {
    const test = this.value.tests.find((entry) => entry.id === testId);
    if (!test) throw new Error("Unknown test");
    return test;
  }

  private replaceTest(
    testId: string,
    update: (test: ResultTest) => ResultTest,
  ) {
    this.value = {
      ...this.value,
      tests: this.value.tests.map((test) =>
        test.id === testId ? update(test) : test,
      ),
    };
  }

  private replaceRunningAttempt(
    testId: string,
    update: (attempt: ResultAttempt) => ResultAttempt,
  ) {
    const test = this.testById(testId);
    const attempt = test.attempts.at(-1);
    if (!attempt || attempt.state !== "running")
      throw new Error("No running attempt");
    this.replaceTest(testId, (current) => ({
      ...current,
      attempts: [...current.attempts.slice(0, -1), update(attempt)],
    }));
  }

  private get lastTest(): string {
    if (this.lastTestId === null) throw new Error("No running attempt");
    return this.lastTestId;
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

  async addDiscoveryProblems(
    problems: NonNullable<RunResult["discoveryProblems"]>,
  ): Promise<void> {
    this.value = {
      ...this.value,
      discoveryProblems: [...(this.value.discoveryProblems ?? []), ...problems],
    };
    await this.publish();
  }

  /** Record the selection size and, for parallel or sharded runs, how it runs. */
  async selectTests(count: number, execution?: ResultExecution): Promise<void> {
    if (!Number.isSafeInteger(count) || count < this.value.tests.length)
      throw new Error("Selected test count is invalid");
    this.value = {
      ...this.value,
      selectedTestCount: count,
      ...(execution ? { execution } : {}),
    };
    await this.publish();
  }

  /** The recording for a selection ordinal, if that test has started. */
  testAt(ordinal: number): TestRecording | undefined {
    for (const [testId, value] of this.ordinals)
      if (value === ordinal) return new TestRecording(this, testId, ordinal);
    return undefined;
  }

  /** The most recently started test, for sequential single-test callers. */
  latestTest(): TestRecording | undefined {
    return this.lastTestId === null
      ? undefined
      : new TestRecording(
          this,
          this.lastTestId,
          this.ordinals.get(this.lastTestId)!,
        );
  }

  /** Start one logical test and its first attempt; inserted in selection order. */
  async beginTest(input: TestStartInput): Promise<TestRecording> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    if (this.ordinals.has(input.id)) throw new Error("Test already started");
    const ordinal =
      input.ordinal ?? Math.max(-1, ...this.ordinals.values()) + 1;
    if ([...this.ordinals.values()].includes(ordinal))
      throw new Error("Test ordinal already started");
    const attempt = newAttempt(this.value.runId, 1, input.lane);
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
    const position = this.value.tests.findIndex(
      (entry) => (this.ordinals.get(entry.id) ?? 0) > ordinal,
    );
    const tests =
      position === -1
        ? [...this.value.tests, test]
        : [
            ...this.value.tests.slice(0, position),
            test,
            ...this.value.tests.slice(position),
          ];
    this.ordinals.set(input.id, ordinal);
    this.lastTestId = input.id;
    this.value = {
      ...this.value,
      tests,
      selectedTestCount: Math.max(
        this.value.selectedTestCount ?? 0,
        tests.length,
      ),
    };
    await this.publish();
    return new TestRecording(this, input.id, ordinal);
  }

  async startTest(input: TestStartInput): Promise<void> {
    await this.beginTest(input);
  }

  /** @internal Use `TestRecording.addAttemptCalls`. */
  async addAttemptCallsFor(
    testId: string,
    calls: readonly ResultCall[],
  ): Promise<void> {
    this.replaceRunningAttempt(testId, (attempt) => ({
      ...attempt,
      calls: [...(attempt.calls ?? []), ...calls],
    }));
    await this.publish();
  }

  async addAttemptCalls(calls: readonly ResultCall[]): Promise<void> {
    await this.addAttemptCallsFor(this.lastTest, calls);
  }

  /** @internal Use `TestRecording.addStep`. */
  async addStepFor(testId: string, step: ResultStep): Promise<void> {
    this.replaceRunningAttempt(testId, (attempt) => {
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
      return {
        ...attempt,
        steps: [...attempt.steps, step],
        problems: problem ? [...attempt.problems, problem] : attempt.problems,
        primaryProblemId: attempt.primaryProblemId ?? problem?.id ?? null,
      };
    });
    await this.publish();
  }

  async addStep(step: ResultStep): Promise<void> {
    await this.addStepFor(this.lastTest, step);
  }

  /** @internal Use `TestRecording.addProblem`. */
  async addProblemFor(testId: string, input: ProblemInput): Promise<void> {
    this.replaceRunningAttempt(testId, (attempt) => {
      const problem: ResultProblem = {
        ...input,
        id: `${attempt.id}:problem:${attempt.problems.length + 1}`,
        ordinal: attempt.problems.length + 1,
      };
      return {
        ...attempt,
        problems: [...attempt.problems, problem],
        primaryProblemId: attempt.primaryProblemId ?? problem.id,
      };
    });
    await this.publish();
  }

  async addProblem(input: ProblemInput): Promise<void> {
    await this.addProblemFor(this.lastTest, input);
  }

  /**
   * @internal Use `TestRecording.startAttempt`. Retry orchestration calls this
   * only after a terminal whole-test attempt.
   */
  async startAttemptFor(testId: string, lane?: number): Promise<void> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    const test = this.testById(testId);
    if (test.attempts.at(-1)?.state === "running")
      throw new Error("No terminal attempt to retry");
    const attempt = newAttempt(
      this.value.runId,
      test.attempts.length + 1,
      lane,
    );
    this.replaceTest(testId, (current) => ({
      ...current,
      state: "running",
      verdict: null,
      flags: [],
      selectedAttemptId: attempt.id,
      attempts: [...current.attempts, attempt],
    }));
    await this.publish();
  }

  async startAttempt(): Promise<void> {
    if (this.value.state !== "running") throw new Error("Run already finished");
    if (this.lastTestId === null)
      throw new Error("No terminal attempt to retry");
    await this.startAttemptFor(this.lastTestId);
  }

  /** @internal Use `TestRecording.finishTest`. */
  async finishTestFor(
    testId: string,
    verdict: "passed" | "failed",
  ): Promise<void> {
    const test = this.testById(testId);
    const attempt = test.attempts.at(-1);
    if (!attempt) throw new Error("No test to finish");
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
    this.replaceTest(testId, (current) => ({
      ...current,
      state: "completed",
      verdict,
      flags,
      attempts: [...current.attempts.slice(0, -1), updatedAttempt],
    }));
    await this.publish();
  }

  async finishTest(verdict: "passed" | "failed"): Promise<void> {
    if (this.lastTestId === null) throw new Error("No test to finish");
    await this.finishTestFor(this.lastTestId, verdict);
  }

  async finish(
    error: RunResult["error"] = null,
    terminalState: "error" | "interrupted" = "error",
  ): Promise<void> {
    const at = new Date().toISOString();
    if (!error && this.value.tests.length === 0)
      error = { code: "no_tests", message: "No tests were executed." };
    if (error) {
      // Parallel lanes can leave several attempts in flight; close them all.
      const runError = error;
      this.value = {
        ...this.value,
        tests: this.value.tests.map((test) => {
          const attempt = test.attempts.at(-1);
          if (attempt?.state !== "running") return test;
          const updatedAttempt: ResultAttempt = {
            ...attempt,
            state: terminalState,
            error: runError,
            timeoutReason:
              runError.code === "run_timeout"
                ? "run_timeout"
                : attempt.timeoutReason,
            finishedAt: at,
            elapsedMs: Math.max(
              0,
              Date.parse(at) - Date.parse(attempt.startedAt),
            ),
          };
          return {
            ...test,
            state: terminalState,
            attempts: [...test.attempts.slice(0, -1), updatedAttempt],
          };
        }),
      };
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
