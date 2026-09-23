import { describe, expect, it } from "vitest";
import { RunRecorder, type ResultStep } from "@sedum-dev/core";
import { renderHtml } from "./html.js";

function step(
  id: string,
  index: number,
  verdict: "passed" | "failed",
  flags: ResultStep["flags"] = [],
): ResultStep {
  return {
    id,
    index,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence:
      index === 1
        ? "verify <script>alert(1)</script>"
        : "verify the total is $42",
    detail: "The amount was checked.",
    sourceStack: [{ file: "checkout.test.yaml", line: index + 2, col: 5 }],
    state: "completed",
    verdict,
    flags,
    elapsedMs: 85,
    page: {
      status: "available",
      observationId: id + ":observation",
      url: "https://shop.test/checkout",
      title: "Checkout",
    },
    locator: null,
    judgement: {
      holds: index === 1 ? 0.58 : 0.66,
      contradicted: 0.2,
      threshold: index === 1 ? 0.85 : 0.75,
      band: 0.15,
      contradictionCutoff: 0.5,
      judgedExcerpt: "Total $42 shown",
    },
    observations: [],
    calls: [
      {
        purpose: "judge",
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
      },
    ],
    error: null,
    evidence: { status: "omitted", reason: "disabled" },
    replayFrame: {
      status: "captured",
      path: "evidence/" + id + ".jpg",
      mediaType: "image/jpeg",
    },
    targetBox: { x: 0.2, y: 0.3, width: 0.1, height: 0.05 },
  };
}

async function example() {
  const recorder = new RunRecorder(async () => {}, "html-test");
  await recorder.start();
  await recorder.startTest({
    id: "pass",
    file: "pass.test.yaml",
    description: "A passing flow",
  });
  await recorder.addStep(step("pass-step", 2, "passed", ["low_confidence"]));
  await recorder.finishTest("passed");
  await recorder.startTest({
    id: "fail",
    file: "fail.test.yaml",
    description: "A failing flow",
  });
  await recorder.addStep(step("fail-step", 1, "failed"));
  await recorder.finishTest("failed");
  await recorder.finish();
  return recorder.snapshot;
}

describe("HTML report", () => {
  it("sorts failures, shows exact per-step lines, escapes data and keeps unknown cost honest", async () => {
    const result = await example();
    const html = renderHtml(result);
    expect(html.indexOf("A failing flow")).toBeLessThan(
      html.indexOf("A passing flow"),
    );
    expect(html).toContain('data-status="flagged"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("fails below 0.70");
    expect(html).toContain("passes at 0.85");
    expect(html).toContain("low_confidence");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("fixture-rate-card");
    expect(html).toContain("all attempts");
    expect(html).toContain("provider total");
    expect(html).toContain("Sedum markup");
    expect(html).toContain('<div class="r-total-band"><span>total</span>');
    expect(html).toContain("input</span><span>160 tk</span><span>$0.000032");
    expect(html).toContain("output</span><span>24 tk</span><span>$0.000019");
    expect(html).not.toContain("data:image/jpeg;base64");
    expect(Buffer.byteLength(html)).toBeLessThan(200_000);
    const incomplete = {
      ...result,
      totals: { ...result.totals, costUsd: null, costComplete: false },
      tests: result.tests.map((test) => ({
        ...test,
        attempts: test.attempts.map((attempt) => ({
          ...attempt,
          steps: attempt.steps.map((value) => ({
            ...value,
            calls: value.calls.map((call) => ({ ...call, costUsd: null })),
          })),
        })),
      })),
    };
    expect(renderHtml(incomplete)).toContain("unknown or incomplete");
  });

  it("embeds only supplied replay frames and escapes player JSON", async () => {
    const result = await example();
    const html = renderHtml(result, {
      replayFrames: new Map([["evidence/fail-step.jpg", "/9j/2Q=="]]),
    });
    expect(html).toContain("data:image/jpeg;base64,/9j/2Q==");
    expect(html).toContain("\\u003cscript");
    expect(html).toContain('"status":"unavailable"');
    expect(html).toContain("data-attempt=");
  });
});
