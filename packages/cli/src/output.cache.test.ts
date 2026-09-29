import { RunRecorder, resultTotals, type ResultStep } from "@sedum-dev/core";
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
    const visual: ResultStep = {
      ...step,
      locator: {
        ...step.locator!,
        vision: {
          outcome: "selected",
          reason: "repeated_member_no_evidence",
          elapsedMs: 2100,
        },
      },
      calls: [
        {
          purpose: "locator",
          modality: "vision",
          requestedModel: "google/gemini-3.8-flash",
          model: "google/gemini-3.8-flash",
          attempts: 1,
          inputTokens: 123,
          outputTokens: 17,
          apiMs: null,
          inputUsdPerMillion: null,
          outputUsdPerMillion: null,
          rateSource: null,
          rateCheckedAt: null,
          costUsd: 0.002,
        },
      ],
    };
    const tests = recorder.snapshot.tests.map((test) => ({
      ...test,
      attempts: test.attempts.map((attempt) => ({
        ...attempt,
        steps: [visual],
      })),
    }));
    const result = { ...recorder.snapshot, tests, totals: resultTotals(tests) };
    for (const costs of [false, true]) {
      const text = renderRunSummary(
        result,
        { stdoutIsTTY: false, stderrIsTTY: false, color: false },
        {
          progressPath: "progress.json",
          resultPath: "result.json",
          authoritative: true,
        },
        costs,
      );
      expect(text).toContain(
        "Vision fallback: selected · google/gemini-3.8-flash · 2100 ms",
      );
      expect(
        text.includes(
          "Vision models: 1 calls · 123 input tokens · 17 output tokens · recorded cost $0.002000",
        ),
      ).toBe(costs);
    }
  });
});
