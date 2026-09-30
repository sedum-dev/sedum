import { RunRecorder, type ResultStep } from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import { runExitCode } from "./exit-policy.js";

function fixtureStep(
  verdict: "passed" | "failed",
  flags: ResultStep["flags"],
): ResultStep {
  return {
    id: "step",
    index: 1,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence: "verify",
    detail: "",
    sourceStack: [{ file: "x.test.yaml", line: 1, col: 1 }],
    state: "completed",
    verdict,
    flags,
    elapsedMs: 0,
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

async function fixture(
  verdict?: "passed" | "failed",
  flags: ResultStep["flags"] = [],
) {
  const recorder = new RunRecorder(async () => undefined, "exit-fixture");
  await recorder.start();
  if (verdict) {
    await recorder.startTest({ id: "test", file: "x.test.yaml" });
    await recorder.addStep(fixtureStep(verdict, flags));
    await recorder.finishTest(verdict);
  }
  await recorder.finish();
  return recorder.snapshot;
}

describe("SED-13 exit policy", () => {
  it("maps clean, flagged, failed, and zero-test results", async () => {
    const clean = await fixture("passed");
    const flagged = await fixture("passed", [
      "low_confidence",
      "contradiction",
    ]);
    const failed = await fixture("failed", ["contradiction"]);
    const zero = await fixture();
    expect([runExitCode(clean, false), runExitCode(clean, true)]).toEqual([
      0, 0,
    ]);
    expect([runExitCode(flagged, false), runExitCode(flagged, true)]).toEqual([
      0, 2,
    ]);
    expect([runExitCode(failed, false), runExitCode(failed, true)]).toEqual([
      1, 1,
    ]);
    expect([runExitCode(zero, false), runExitCode(zero, true)]).toEqual([3, 3]);
  });

  it("flags a pass that needed a retry, so --strict exits 2", async () => {
    const recorder = new RunRecorder(async () => undefined, "flaky-fixture");
    await recorder.start();
    await recorder.startTest({ id: "test", file: "x.test.yaml" });
    await recorder.addStep(fixtureStep("failed", []));
    await recorder.finishTest("failed");
    await recorder.startAttempt();
    await recorder.addStep({ ...fixtureStep("passed", []), id: "retry" });
    await recorder.finishTest("passed");
    await recorder.finish();
    const result = recorder.snapshot;
    expect(result.tests[0]?.attempts.map((attempt) => attempt.flags)).toEqual([
      [],
      ["flaky"],
    ]);
    expect(result.tests[0]?.flags).toEqual(["flaky"]);
    expect(result.flags).toEqual(["flaky"]);
    expect(result.verdict).toBe("passed");
    // No step was flagged; only the attempt history makes it flaky.
    expect(result.totals.flaggedSteps).toBe(0);
    expect([runExitCode(result, false), runExitCode(result, true)]).toEqual([
      0, 2,
    ]);
  });
});
