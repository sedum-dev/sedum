import { RunRecorder, type ResultStep } from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import { renderRunSummary } from "./output.js";

describe("cache outcome in terminal summary", () => {
  it("shows a changed target and fallback without changing the pass verdict", async () => {
    const recorder = new RunRecorder(async () => undefined, "cache-output");
    await recorder.start();
    await recorder.startTest({ id: "test", file: "cart.test.yaml" });
    const step: ResultStep = {
      id: "step",
      index: 1,
      kind: "action",
      operation: "click",
      phase: "steps",
      sentence: "click Add to cart",
      detail: "",
      sourceStack: [{ file: "cart.test.yaml", line: 2, col: 5 }],
      state: "completed",
      verdict: "passed",
      flags: [],
      elapsedMs: 5,
      page: { status: "omitted", reason: "sensitive_page" },
      locator: {
        confidence: null,
        source: "model",
        options: [],
        cache: {
          outcome: "miss",
          reason: "strong_signal_conflict",
          fallbackCalledModel: true,
          targetChanged: true,
        },
      },
      judgement: null,
      observations: [],
      calls: [],
      error: null,
      evidence: { status: "omitted", reason: "sensitive_page" },
      replayFrame: null,
      targetBox: null,
    };
    await recorder.addStep(step);
    await recorder.finishTest("passed");
    await recorder.finish();
    const output = renderRunSummary(
      recorder.snapshot,
      { stdoutIsTTY: false, stderrIsTTY: false, color: false },
      {
        progressPath: "progress.json",
        resultPath: "result.json",
        authoritative: true,
      },
      false,
    );
    expect(output).toContain("test PASSED");
    expect(output).toContain(
      "cache miss (strong_signal_conflict), model fallback, target changed",
    );
  });
});
