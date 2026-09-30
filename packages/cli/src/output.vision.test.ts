import { RunRecorder, type ResultStep } from "@sedum-dev/core";
import { describe, expect, it } from "vitest";
import { renderRunSummary } from "./output.js";

const click: ResultStep = {
  id: "click",
  index: 1,
  kind: "action",
  operation: "click",
  phase: "steps",
  sentence: "click the grey top",
  detail: "",
  sourceStack: [{ file: "vision.test.yaml", line: 3, col: 5 }],
  state: "completed",
  verdict: "failed",
  flags: [],
  elapsedMs: 10,
  page: { status: "omitted", reason: "sensitive_page" },
  locator: { confidence: null, source: "none", options: [], cache: null },
  judgement: null,
  observations: [],
  calls: [],
  error: {
    code: "no_match",
    message: "Vision needs 2 to 40 visible controls.",
  },
  evidence: { status: "omitted", reason: "sensitive_page" },
  replayFrame: null,
  targetBox: null,
};

async function render(
  steps: ResultStep[],
  key: "accepted" | "rejected" = "accepted",
) {
  const recorder = new RunRecorder(async () => undefined, "vision-summary");
  await recorder.start();
  await recorder.selectTests(1, {
    parallel: { requested: 1, lanes: 1 },
    shard: null,
    providerConcurrency: 2,
    vision: { model: "vision-model", key },
  });
  await recorder.startTest({ id: "test", file: "vision.test.yaml" });
  for (const [index, step] of steps.entries()) {
    await recorder.addStep({ ...step, id: `step-${index}`, index: index + 1 });
  }
  const errored = steps.find((step) => step.state === "error");
  if (errored) await recorder.errorTestFor("test", errored.error!);
  else await recorder.finishTest("failed");
  await recorder.finish(errored?.error ?? null);
  return renderRunSummary(
    recorder.snapshot,
    { stdoutIsTTY: false, stderrIsTTY: false, color: false },
    {
      progressPath: "progress.json",
      resultPath: "result.json",
      authoritative: true,
    },
    false,
  );
}

describe("vision execution summary", () => {
  it.each([
    { state: "completed", verdict: "failed" },
    { state: "error", verdict: null },
  ] as const)(
    "does not claim text resolution for an unresolved click ($state)",
    async (outcome) => {
      const output = await render([{ ...click, ...outcome }]);
      expect(output).toContain(
        "vision vision-model: enabled, no fallback attempted",
      );
      expect(output).toContain(
        "vision not attempted on 1 failed click step(s)",
      );
      expect(output).not.toContain("every click was resolved");
    },
  );

  it("counts actual outcomes separately from requests and unrelated failures", async () => {
    const output = await render([
      ...(
        [
          "selected",
          "selected",
          "abstained",
          "failed",
          "failed",
          "failed",
        ] as const
      ).map((outcome) => ({
        ...click,
        locator: { ...click.locator!, vision: { outcome, elapsedMs: 10 } },
      })),
      click,
      { ...click, operation: "type" },
      { ...click, verdict: "passed", error: null },
    ]);
    expect(output).toContain(
      "vision vision-model: attempted on 6 step(s); 2 selected, 1 abstained, 3 failed",
    );
    expect(output).toContain("vision not attempted on 1 failed click step(s)");
  });

  it("does not infer successful selection from older diagnostics without an outcome", async () => {
    const output = await render([
      { ...click, locator: { ...click.locator!, vision: { elapsedMs: 10 } } },
      {
        ...click,
        locator: {
          ...click.locator!,
          vision: { elapsedMs: 10, failure: "timeout" },
        },
      },
    ]);
    expect(output).toContain(
      "attempted on 2 step(s); 0 selected, 0 abstained, 1 failed, 1 outcome unrecorded",
    );
  });

  it("reports a rejected-key request as failed, not successful use", async () => {
    const output = await render(
      [
        {
          ...click,
          locator: {
            ...click.locator!,
            vision: {
              outcome: "failed",
              elapsedMs: 10,
              failure: "http_error",
              httpStatus: 401,
            },
          },
        },
      ],
      "rejected",
    );
    expect(output).toContain(
      "attempted on 1 step(s); 0 selected, 0 abstained, 1 failed",
    );
    expect(output).toContain("OpenRouter rejected OPEN_ROUTER_API_KEY");
    expect(output).not.toContain("used on");
    expect(output).not.toContain("vision not attempted on");
  });
});
