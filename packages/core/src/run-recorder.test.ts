import { describe, expect, it } from "vitest";
import { RunRecorder } from "./run-recorder.js";
import {
  validateRunResult,
  type ResultStep,
  type RunResult,
} from "./run-result.js";

function step(id: string, index: number): ResultStep {
  return {
    id,
    index,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence: `verify ${id}`,
    detail: "",
    sourceStack: [{ file: "t.test.yaml", line: index, col: 1 }],
    state: "completed",
    verdict: "passed",
    flags: [],
    elapsedMs: 1,
    page: { status: "unavailable", reason: "fixture" },
    locator: null,
    judgement: null,
    observations: [],
    calls: [],
    error: null,
    evidence: { status: "omitted", reason: "fixture" },
    replayFrame: null,
    targetBox: null,
  };
}

function recorder() {
  const snapshots: RunResult[] = [];
  const value = new RunRecorder(async (snapshot) => {
    snapshots.push(validateRunResult(snapshot));
  }, "run");
  return { value, snapshots };
}

describe("RunRecorder with concurrent tests", () => {
  it("keeps tests in selection order and routes interleaved writes to their own test", async () => {
    const { value } = recorder();
    await value.start();
    await value.selectTests(3, {
      parallel: { requested: 3, lanes: 3 },
      shard: null,
      providerConcurrency: 4,
    });
    const third = await value.beginTest({
      id: "c",
      file: "c",
      ordinal: 2,
      lane: 0,
    });
    const first = await value.beginTest({
      id: "a",
      file: "a",
      ordinal: 0,
      lane: 1,
    });
    const second = await value.beginTest({
      id: "b",
      file: "b",
      ordinal: 1,
      lane: 2,
    });
    await Promise.all([
      first.addStep(step("a1", 1)),
      third.addStep(step("c1", 1)),
      second.addStep(step("b1", 1)),
    ]);
    await third.finishTest("passed");
    await first.addStep(step("a2", 2));
    await first.finishTest("passed");
    await second.finishTest("passed");
    await value.finish();
    const result = value.snapshot;
    expect(result.tests.map((test) => test.id)).toEqual(["a", "b", "c"]);
    expect(
      result.tests.map((test) =>
        test.attempts[0]!.steps.map((entry) => entry.id),
      ),
    ).toEqual([["a1", "a2"], ["b1"], ["c1"]]);
    expect(result.tests.map((test) => test.attempts[0]!.lane)).toEqual([
      1, 2, 0,
    ]);
    expect(result.execution?.parallel.lanes).toBe(3);
    expect(result.verdict).toBe("passed");
  });

  it("retries one test without touching another that is still running", async () => {
    const { value } = recorder();
    await value.start();
    const a = await value.beginTest({
      id: "a",
      file: "a",
      ordinal: 0,
      lane: 0,
    });
    const b = await value.beginTest({
      id: "b",
      file: "b",
      ordinal: 1,
      lane: 1,
    });
    await a.addProblem({
      origin: "module_binding",
      outcome: "failed",
      phase: "steps",
      sourceStack: [{ file: "a", line: 1, col: 1 }],
      stepId: null,
      error: { code: "x", message: "failed" },
    });
    await a.finishTest("failed");
    expect(value.testAt(0)?.currentAttempt?.running).toBe(false);
    await value.testAt(0)!.startAttempt(0);
    await b.addStep(step("b1", 1));
    expect(a.currentAttempt).toMatchObject({
      ordinal: 2,
      running: true,
      stepCount: 0,
    });
    expect(b.currentAttempt).toMatchObject({
      ordinal: 1,
      running: true,
      stepCount: 1,
    });
    await a.finishTest("passed");
    await b.finishTest("passed");
    await value.finish();
    expect(
      value.snapshot.tests[0]!.attempts.map((attempt) => attempt.verdict),
    ).toEqual(["failed", "passed"]);
  });

  it("closes every running attempt when the run ends early", async () => {
    const { value } = recorder();
    await value.start();
    await value.beginTest({ id: "a", file: "a", ordinal: 0 });
    await value.beginTest({ id: "b", file: "b", ordinal: 1 });
    const done = await value.beginTest({ id: "c", file: "c", ordinal: 2 });
    await done.finishTest("passed");
    await value.finish(
      { code: "run_timeout", message: "The run deadline expired." },
      "error",
    );
    const result = value.snapshot;
    expect(result.tests.map((test) => test.state)).toEqual([
      "error",
      "error",
      "completed",
    ]);
    for (const test of result.tests.slice(0, 2))
      expect(test.attempts[0]).toMatchObject({
        state: "error",
        timeoutReason: "run_timeout",
      });
  });

  it("keeps the sequential API working on the latest test", async () => {
    const { value } = recorder();
    await value.start();
    await value.startTest({ id: "only", file: "only" });
    await value.addStep(step("s1", 1));
    await value.addAttemptCalls([]);
    expect(value.latestTest()?.currentAttempt?.stepCount).toBe(1);
    await value.finishTest("passed");
    await value.finish();
    expect(value.snapshot.verdict).toBe("passed");
  });

  it("rejects duplicate tests, reused ordinals, and writes without a running attempt", async () => {
    const { value } = recorder();
    await value.start();
    await expect(value.addStep(step("x", 1))).rejects.toThrow(
      "No running attempt",
    );
    await expect(value.startAttempt()).rejects.toThrow("No terminal attempt");
    await expect(value.finishTest("passed")).rejects.toThrow(
      "No test to finish",
    );
    const a = await value.beginTest({ id: "a", file: "a", ordinal: 0 });
    await expect(
      value.beginTest({ id: "a", file: "a2", ordinal: 1 }),
    ).rejects.toThrow("Test already started");
    await expect(
      value.beginTest({ id: "z", file: "z", ordinal: 0 }),
    ).rejects.toThrow("Test ordinal already started");
    await expect(a.startAttempt()).rejects.toThrow(
      "No terminal attempt to retry",
    );
    expect(value.testAt(5)).toBeUndefined();
    await a.finishTest("passed");
    await value.finish();
    await expect(value.beginTest({ id: "b", file: "b" })).rejects.toThrow(
      "Run already finished",
    );
  });

  it("rejects a shard index above the count", () => {
    expect(() =>
      validateRunResult({
        ...new RunRecorder(async () => undefined).snapshot,
        execution: {
          parallel: { requested: "auto", lanes: 1 },
          shard: { index: 3, count: 2, globalSelectedTests: 4 },
          providerConcurrency: 2,
        },
      }),
    ).toThrow("Shard index exceeds shard count");
  });

  it("exposes the recorded test and supports legacy problems on the latest test", async () => {
    const { value } = recorder();
    await value.start();
    const test = await value.beginTest({ id: "a", file: "a.test.yaml" });
    expect(test.file).toBe("a.test.yaml");
    expect(test.test.attempts).toHaveLength(1);
    await value.addProblem({
      origin: "module_binding",
      outcome: "failed",
      phase: "steps",
      sourceStack: [{ file: "a.test.yaml", line: 1, col: 1 }],
      stepId: null,
      error: { code: "x", message: "failed" },
    });
    await value.finishTest("failed");
    await value.startAttempt();
    expect(value.latestTest()?.currentAttempt?.ordinal).toBe(2);
    expect(() => value.testById("missing")).toThrow("Unknown test");
  });
});
