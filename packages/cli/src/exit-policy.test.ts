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
});
