import { describe, expect, it } from "vitest";
import { RunRecorder, type ResultStep, type RunResult } from "@sedum-dev/core";
import { ReporterLifecycle } from "./lifecycle.js";
import { createTerminalReporter, type ReporterContext } from "./terminal.js";

const context: ReporterContext = {
  stdoutIsTTY: false,
  color: false,
  showCosts: false,
  progressPath: "/tmp/run/progress.json",
  resultPath: "/tmp/run/result.json",
  authoritative: true,
  includeSharedSummary: true,
};

function step(): ResultStep {
  return {
    id: "step-1",
    index: 1,
    kind: "verify",
    operation: "verify",
    phase: "steps",
    sentence:
      "verify the entire checkout total and tax explanation is visible without shortening this sentence",
    detail: "The total was just below the pass line.",
    sourceStack: [
      { file: "tests/checkout.test.yaml", line: 12, col: 5 },
      { file: "tests/common.module.yaml", line: 8, col: 3 },
    ],
    state: "completed",
    verdict: "passed",
    flags: ["low_confidence", "contradiction"],
    elapsedMs: 100,
    page: {
      status: "available",
      observationId: "obs-1",
      url: "https://shop.test/checkout",
      title: "Checkout",
    },
    locator: null,
    judgement: {
      holds: 0.64,
      contradicted: 0.51,
      threshold: 0.75,
      band: 0.15,
      contradictionCutoff: 0.5,
      judgedExcerpt: "Tax is shown, total differs",
    },
    observations: [
      {
        id: "obs-1",
        ordinal: 1,
        elapsedMs: 90,
        outcome: "accepted",
        reason: null,
        timeoutReason: null,
      },
    ],
    calls: [],
    error: null,
    evidence: {
      status: "captured",
      path: "evidence/checkout.jpg",
      mediaType: "image/jpeg",
    },
    replayFrame: null,
    targetBox: null,
  };
}

async function snapshots(): Promise<RunResult[]> {
  const snapshots: RunResult[] = [];
  const recorder = new RunRecorder(async (value) => {
    snapshots.push(value);
  }, "reporter-fixture");
  await recorder.start();
  await recorder.startTest({
    id: "checkout",
    file: "tests/checkout.test.yaml",
  });
  await recorder.addStep(step());
  await recorder.addProblem({
    origin: "module_binding",
    outcome: "failed",
    phase: "after",
    sourceStack: [{ file: "tests/common.module.yaml", line: 19, col: 3 }],
    stepId: null,
    error: { code: "missing_binding", message: "Expected a subtotal binding." },
  });
  await recorder.finishTest("failed");
  await recorder.finish();
  return snapshots;
}

describe("terminal reporters", () => {
  it("emits each lifecycle event once across repeated snapshots", async () => {
    const lifecycle = new ReporterLifecycle();
    const values = await snapshots();
    const events = values.flatMap((value) => [
      ...lifecycle.feed(value),
      ...lifecycle.feed(value),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "runStarted",
      "testStarted",
      "attemptStarted",
      "stepCompleted",
      "problemRecorded",
      "attemptCompleted",
      "testCompleted",
      "runCompleted",
    ]);
  });

  it("shows the full flagged step and action paths in plain output", async () => {
    const values = await snapshots();
    const final = values.at(-1)!;
    const lifecycle = new ReporterLifecycle();
    const reporter = createTerminalReporter("steps");
    const live = values
      .flatMap((value) =>
        lifecycle.feed(value).map((event) => reporter.onEvent(event, context)),
      )
      .join("");
    const end = reporter.onResult(final, context);
    expect(live).toContain(
      "step 1: verify the entire checkout total and tax explanation is visible without shortening this sentence",
    );
    expect(end).toContain(
      "tests/checkout.test.yaml:12 <- tests/common.module.yaml:8",
    );
    expect(end).toContain(
      "holds 0.64, contradicted 0.51, threshold 0.75, band 0.15, contradiction cutoff 0.5",
    );
    expect(end).toContain('https://shop.test/checkout "Checkout"');
    expect(end).toContain("/tmp/run/evidence/checkout.jpg");
    expect(end).toContain("missing_binding: Expected a subtotal binding.");
    expect(end).toContain("read /tmp/run/result.json");
    expect(end).toContain("rerun sedum run 'tests/checkout.test.yaml'");
    expect(`${live}${end}`).not.toContain(String.fromCharCode(27));
    expect(`${live}${end}`).not.toContain("…");
  });

  it("does not claim an unavailable artifact is readable", async () => {
    const final = (await snapshots()).at(-1)!;
    const output = createTerminalReporter("list").onResult(final, {
      ...context,
      authoritative: false,
    });
    expect(output).toContain("result unavailable");
    expect(output).not.toContain("read /tmp/run/result.json");
  });

  it("quotes the requested file for an operational rerun", async () => {
    const recorder = new RunRecorder(
      async () => undefined,
      "operational-fixture",
    );
    await recorder.start();
    await recorder.finish({
      code: "missing_key",
      message: "Missing provider key.",
    });
    const output = createTerminalReporter("list").onResult(recorder.snapshot, {
      ...context,
      rerunFile: "tests/customer's checkout.test.yaml",
    });
    expect(output).toContain(
      "rerun sedum run 'tests/customer'\\''s checkout.test.yaml'",
    );
  });

  it("shows canonical problem reasons and reruns a partially executed test", async () => {
    const recorder = new RunRecorder(async () => undefined, "failed-fixture");
    await recorder.start();
    await recorder.startTest({ id: "failed", file: "tests/failed.test.yaml" });
    await recorder.addStep({
      ...step(),
      verdict: "failed",
      flags: [],
      detail: "",
      error: null,
    });
    await recorder.finishTest("failed");
    await recorder.finish();
    const output = createTerminalReporter("list").onResult(
      recorder.snapshot,
      context,
    );
    expect(output).toContain("step_failed: The step failed.");
    expect(output).toContain("rerun sedum run 'tests/failed.test.yaml'");

    const partial = new RunRecorder(async () => undefined, "partial-fixture");
    await partial.start();
    await partial.startTest({ id: "partial", file: "tests/partial.test.yaml" });
    await partial.finish({
      code: "browser_lost",
      message: "The browser disconnected.",
    });
    const partialOutput = createTerminalReporter("list").onResult(
      partial.snapshot,
      context,
    );
    expect(partialOutput).toContain(
      "test error browser_lost: The browser disconnected.",
    );
    expect(partialOutput).toContain(
      "rerun sedum run 'tests/partial.test.yaml'",
    );
  });
});
