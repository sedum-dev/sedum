import { describe, expect, it } from "vitest";
import {
  ResultLocatorSchema,
  RunRecorder,
  validateRunResult,
  type ResultStep,
} from "@sedum-dev/core";
import { renderJson } from "./index.js";

const modelCall = {
  purpose: "locator" as const,
  requestedModel: "jev-latest",
  model: "jev-1.13.0",
  attempts: 1,
  inputTokens: 80,
  outputTokens: 12,
  apiMs: 43,
  inputUsdPerMillion: 0.2,
  outputUsdPerMillion: 0.8,
  rateSource: "fixture-rate-card",
  rateCheckedAt: "2026-09-01",
  costUsd: 0.0000256,
};

function reportStep(
  id: string,
  index: number,
  kind: "action" | "verify",
): ResultStep {
  return {
    id,
    index,
    kind,
    operation: kind === "action" ? "click" : "verify",
    phase: "steps",
    sentence:
      kind === "action"
        ? "click the Checkout button"
        : "verify the total is $42",
    detail:
      kind === "action"
        ? "The target was ambiguous."
        : "The amount appears low-confidence.",
    sourceStack: [{ file: "checkout.test.yaml", line: index + 2, col: 5 }],
    state: "completed",
    verdict: kind === "action" ? "failed" : "passed",
    flags: kind === "verify" ? ["low_confidence"] : [],
    elapsedMs: index * 100,
    page: {
      status: "available",
      observationId: `${id}:observation:2`,
      url: "https://shop.test/checkout",
      title: "Checkout",
    },
    locator:
      kind === "action"
        ? {
            confidence: 0.48,
            source: "model",
            options: [
              { label: "Checkout", role: "button", probability: 0.48 },
              { label: "(no match)", role: "", probability: 0.32 },
              {
                label: "Checkout another order",
                role: "link",
                probability: 0.2,
              },
            ],
            cache: {
              outcome: "miss",
              reason: "validation_changed",
              fallbackCalledModel: true,
              targetChanged: true,
            },
          }
        : null,
    judgement:
      kind === "verify"
        ? {
            holds: 0.65,
            contradicted: 0.2,
            threshold: 0.75,
            band: 0.15,
            contradictionCutoff: 0.5,
            judgedExcerpt: "Total $42 visible in order summary",
          }
        : null,
    observations: [
      {
        id: `${id}:observation:1`,
        ordinal: 1,
        elapsedMs: 20,
        outcome: "retried",
        reason: "stale_observation",
        timeoutReason: null,
      },
      {
        id: `${id}:observation:2`,
        ordinal: 2,
        elapsedMs: 60,
        outcome: "accepted",
        reason: null,
        timeoutReason: null,
      },
    ],
    calls:
      kind === "action"
        ? [modelCall]
        : [{ ...modelCall, purpose: "judge", costUsd: null }],
    error:
      kind === "action"
        ? {
            code: "ambiguous",
            message: "Could not choose the button.",
            callLog: ["element is visible, enabled and stable"],
          }
        : null,
    evidence: {
      status: "captured",
      path: `evidence/${id}.jpg`,
      mediaType: "image/jpeg",
    },
    replayFrame: {
      status: "captured",
      path: `evidence/${id}-replay.jpg`,
      mediaType: "image/jpeg",
    },
    targetBox:
      kind === "action" ? { x: 0.2, y: 0.3, width: 0.1, height: 0.05 } : null,
  };
}

describe("PoC report capability contract", () => {
  it("feeds JSON, Markdown triage, HTML bars/replay and cost receipt from one result", async () => {
    const recorder = new RunRecorder(async () => {}, "report-parity");
    await recorder.start();
    await recorder.startTest({
      id: "checkout",
      file: "checkout.test.yaml",
      description: "Checkout price",
      tags: ["smoke"],
    });
    await recorder.addStep(reportStep("action", 1, "action"));
    await recorder.addStep(reportStep("verify", 2, "verify"));
    await recorder.finishTest("failed");
    await recorder.finish();
    const canonical = validateRunResult(recorder.snapshot);
    const serialized = validateRunResult(JSON.parse(renderJson(canonical)));
    expect(serialized).toEqual(canonical);
    const test = serialized.tests[0]!;
    const [action, assertion] = test.attempts[0]!.steps;
    // Markdown attention fields: source, safe details, choices, exact scores and evidence.
    expect([
      test.verdict,
      action!.sourceStack[0]!.file,
      action!.detail,
      action!.locator!.options[1]!.label,
      action!.evidence.status,
      assertion!.judgement!.holds,
      assertion!.judgement!.threshold,
    ]).toEqual([
      "failed",
      "checkout.test.yaml",
      "The target was ambiguous.",
      "(no match)",
      "captured",
      0.65,
      0.75,
    ]);
    // HTML scan, bars, optional replay and actual receipt inputs.
    expect(serialized.totals).toMatchObject({
      failedTests: 1,
      flaggedSteps: 1,
      modelCalls: 2,
      inputTokens: 160,
      outputTokens: 24,
      costUsd: null,
      costComplete: false,
    });
    expect(action!.locator).toMatchObject({
      confidence: 0.48,
      cache: {
        outcome: "miss",
        fallbackCalledModel: true,
        targetChanged: true,
      },
    });
    expect(action!.replayFrame?.status).toBe("captured");
    expect(action!.targetBox).toEqual({
      x: 0.2,
      y: 0.3,
      width: 0.1,
      height: 0.05,
    });
    expect(action!.calls[0]).toMatchObject({
      model: "jev-1.13.0",
      rateSource: "fixture-rate-card",
      rateCheckedAt: "2026-09-01",
      costUsd: 0.0000256,
    });
    expect(
      action!.observations.map((observation) => observation.outcome),
    ).toEqual(["retried", "accepted"]);
    // Strict may gate this flagged pass later; the canonical step stays passed.
    expect(assertion).toMatchObject({
      verdict: "passed",
      flags: ["low_confidence"],
    });
  });

  it("distinguishes cache hit, miss and bypass reason without inventing model calls", () => {
    const base = reportStep("cache", 1, "action").locator!;
    for (const [outcome, reason] of [
      ["hit", null],
      ["miss", "validation_changed"],
      ["bypassed", "ci_default"],
      ["bypassed", "outside_git"],
      ["bypassed", "disabled"],
    ] as const) {
      expect(
        ResultLocatorSchema.parse({
          ...base,
          source: outcome === "hit" ? "cache" : "model",
          cache: {
            outcome,
            reason,
            fallbackCalledModel: outcome !== "hit",
            targetChanged: false,
          },
        }).cache?.outcome,
      ).toBe(outcome);
    }
  });
});
