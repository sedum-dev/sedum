import {
  resultTotals,
  RunRecorder,
  validateRunResult,
  type ResultStep,
  type RunResult,
} from "@sedum-dev/core";

/*
 * Golden RunResults shared by reporter tests. Test-only: not a build entry,
 * so it never ships. Timestamps and durations are frozen so rendered output
 * is byte-stable across runs.
 */

export const modelCall = {
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

export function reportStep(
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

/** A step for one test file; `outcome` picks verdict, flags and evidence. */
export function step(
  file: string,
  index: number,
  outcome:
    | "passed"
    | "low_confidence"
    | "contradiction"
    | "both"
    | "failed_verify"
    | "failed_action"
    | "error",
  overrides: Partial<ResultStep> = {},
): ResultStep {
  const verify = outcome !== "failed_action" && outcome !== "error";
  const flags: ResultStep["flags"] =
    outcome === "low_confidence"
      ? ["low_confidence"]
      : outcome === "contradiction"
        ? ["contradiction"]
        : outcome === "both"
          ? ["low_confidence", "contradiction"]
          : [];
  const failed = outcome === "failed_verify" || outcome === "failed_action";
  const attention = failed || outcome === "error" || flags.length > 0;
  const id = `${file}:step:${index}`;
  return {
    ...reportStep(id, index, verify ? "verify" : "action"),
    sentence: verify
      ? `verify the cart shows ${index} item${index === 1 ? "" : "s"}`
      : "click the Checkout button",
    detail: failed
      ? verify
        ? "The claim was not supported."
        : "The target was ambiguous."
      : outcome === "error"
        ? "The browser disconnected."
        : flags.length
          ? "The claim held with reservations."
          : "",
    sourceStack: [{ file, line: index + 2, col: 5 }],
    state: outcome === "error" ? "error" : "completed",
    verdict: outcome === "error" ? null : failed ? "failed" : "passed",
    flags,
    judgement: verify
      ? {
          holds:
            outcome === "failed_verify"
              ? 0.31
              : outcome === "low_confidence" || outcome === "both"
                ? 0.7449
                : 0.92,
          contradicted:
            outcome === "contradiction" || outcome === "both" ? 0.61 : 0.08,
          threshold: 0.75,
          band: 0.15,
          contradictionCutoff: 0.5,
          judgedExcerpt: attention ? "Cart (2)\nSubtotal $42.00" : null,
        }
      : null,
    locator: verify ? null : reportStep(id, index, "action").locator,
    calls: [],
    error:
      outcome === "failed_action"
        ? {
            code: "ambiguous",
            message: "Could not choose the button.",
            callLog: [
              "waiting for getByRole('button', { name: 'Checkout' })",
              "element is visible, enabled and stable",
            ],
          }
        : outcome === "error"
          ? { code: "browser_closed", message: "The browser disconnected." }
          : null,
    evidence: attention
      ? {
          status: "captured",
          path: `evidence/a1-000000000000/${index.toString().padStart(24, "0")}.jpg`,
          mediaType: "image/jpeg",
        }
      : { status: "omitted", reason: "passed" },
    replayFrame: null,
    targetBox: null,
    ...overrides,
  };
}

const FROZEN = "2026-09-23T10:00:00.000Z";

/** Fix every clock reading and random ID so renders are stable, then re-validate. */
export function freeze(result: RunResult): RunResult {
  const tests = result.tests.map((test, testIndex) => {
    const ids = new Map(
      test.attempts.map((attempt, attemptIndex) => [
        attempt.id,
        `${result.runId}:attempt:${testIndex + 1}.${attemptIndex + 1}`,
      ]),
    );
    return {
      ...test,
      selectedAttemptId:
        test.selectedAttemptId === null
          ? null
          : ids.get(test.selectedAttemptId)!,
      attempts: test.attempts.map((attempt, attemptIndex) => {
        const id = ids.get(attempt.id)!;
        const problemId = (value: string) => value.replace(attempt.id, id);
        return {
          ...attempt,
          id,
          startedAt: FROZEN,
          finishedAt: attempt.finishedAt === null ? null : FROZEN,
          elapsedMs: 1000 * (testIndex + 1) + 250 * attemptIndex,
          problems: attempt.problems.map((problem) => ({
            ...problem,
            id: problemId(problem.id),
          })),
          primaryProblemId:
            attempt.primaryProblemId === null
              ? null
              : problemId(attempt.primaryProblemId),
        };
      }),
    };
  });
  return validateRunResult({
    ...result,
    startedAt: FROZEN,
    updatedAt: FROZEN,
    finishedAt: result.finishedAt === null ? null : FROZEN,
    elapsedMs: 4321,
    tests,
  });
}

type Spec = {
  readonly file: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** One entry per attempt; each attempt lists its steps. */
  readonly attempts: readonly (readonly ResultStep[])[];
};

async function record(
  runId: string,
  specs: readonly Spec[],
  end: (recorder: RunRecorder) => Promise<void> = (recorder) =>
    recorder.finish(),
): Promise<RunResult> {
  const recorder = new RunRecorder(async () => undefined, runId);
  await recorder.start();
  for (const spec of specs) {
    await recorder.startTest({
      id: `test:${spec.file}`,
      file: spec.file,
      description: spec.description ?? "",
      tags: spec.tags ?? [],
    });
    for (const [index, steps] of spec.attempts.entries()) {
      if (index > 0) await recorder.startAttempt();
      for (const item of steps) await recorder.addStep(item);
      await recorder.finishTest(
        steps.some((item) => item.verdict === "failed") ? "failed" : "passed",
      );
    }
  }
  await end(recorder);
  return freeze(recorder.snapshot);
}

const cart = "tests/cart.test.yaml";
const login = "tests/login.test.yaml";
const checkout = "tests/checkout.test.yaml";

export const fixtures = {
  clean: () =>
    record("run-clean", [
      {
        file: login,
        description: "Signs in and sees products",
        attempts: [[step(login, 1, "passed"), step(login, 2, "passed")]],
      },
    ]),
  flagged: (flag: "low_confidence" | "contradiction" | "both") =>
    record(`run-flagged-${flag}`, [
      {
        file: cart,
        description: "Cart shows the added item",
        attempts: [[step(cart, 1, "passed"), step(cart, 2, flag)]],
      },
    ]),
  failedVerify: () =>
    record("run-failed-verify", [
      {
        file: cart,
        description: "Cart shows the added item",
        attempts: [[step(cart, 1, "passed"), step(cart, 2, "failed_verify")]],
      },
    ]),
  failedAction: () =>
    record("run-failed-action", [
      {
        file: checkout,
        description: "",
        attempts: [[step(checkout, 1, "failed_action")]],
      },
    ]),
  /** Failed, flagged and clean together: the golden sample for CI summaries. */
  mixed: () =>
    record("run-mixed", [
      {
        file: login,
        description: "Signs in and sees products",
        tags: ["smoke"],
        attempts: [[step(login, 1, "passed"), step(login, 2, "passed")]],
      },
      {
        file: cart,
        description: "Cart shows the added item",
        attempts: [[step(cart, 1, "passed"), step(cart, 2, "low_confidence")]],
      },
      {
        file: checkout,
        description: "Checks out with the saved card",
        attempts: [
          [step(checkout, 1, "passed"), step(checkout, 2, "failed_action")],
        ],
      },
    ]),
  failedAndFlagged: () =>
    record("run-failed-flagged", [
      {
        file: cart,
        attempts: [
          [step(cart, 1, "contradiction"), step(cart, 2, "failed_verify")],
        ],
      },
    ]),
  retriedThenPassed: () =>
    record("run-retried", [
      {
        file: checkout,
        attempts: [
          [step(checkout, 1, "failed_action")],
          [step(checkout, 1, "passed", { id: `${checkout}:retry:1` })],
        ],
      },
    ]),
  retriesExhausted: () =>
    record("run-exhausted", [
      {
        file: checkout,
        attempts: [
          [step(checkout, 1, "failed_action")],
          [step(checkout, 1, "failed_action", { id: `${checkout}:retry:1` })],
        ],
      },
    ]),
  operationalError: () =>
    record(
      "run-error",
      [{ file: login, attempts: [[step(login, 1, "passed")]] }],
      async (recorder) => {
        await recorder.startTest({ id: `test:${checkout}`, file: checkout });
        await recorder.addStep(step(checkout, 1, "error"));
        await recorder.finish({
          code: "execution_error",
          message: "The browser disconnected.",
          callLog: ["browser.newContext: Target closed"],
        });
      },
    ),
  interrupted: () =>
    record("run-interrupted", [], async (recorder) => {
      await recorder.selectTests(3);
      await recorder.startTest({ id: `test:${cart}`, file: cart });
      await recorder.addStep(step(cart, 1, "passed"));
      await recorder.finish(
        { code: "canceled", message: "The run was interrupted." },
        "interrupted",
      );
    }),
  /** --strict with a flagged pass and then a deadline: one error, no failure. */
  flaggedThenTimeout: () =>
    record(
      "run-flagged-timeout",
      [{ file: cart, attempts: [[step(cart, 1, "low_confidence")]] }],
      async (recorder) => {
        await recorder.selectTests(2);
        await recorder.startTest({ id: `test:${checkout}`, file: checkout });
        await recorder.addStep(step(checkout, 1, "passed"));
        await recorder.finish(
          { code: "run_timeout", message: "The run deadline expired." },
          "error",
        );
      },
    ),
  moduleBinding: () =>
    record("run-module", [], async (recorder) => {
      await recorder.startTest({ id: `test:${login}`, file: login });
      await recorder.addProblem({
        origin: "module_binding",
        outcome: "error",
        phase: "before",
        sourceStack: [
          { file: login, line: 3, col: 5 },
          { file: "modules/ui-login.module.yaml", line: 1, col: 1 },
        ],
        stepId: null,
        error: {
          code: "module_binding",
          message: "Module input 'password' is not set.",
        },
      });
      await recorder.finish({
        code: "module_binding",
        message: "Module input 'password' is not set.",
      });
    }),
  noTests: () => record("run-no-tests", []),
  discovery: () =>
    record(
      "run-discovery",
      [{ file: login, attempts: [[step(login, 1, "passed")]] }],
      async (recorder) => {
        await recorder.addDiscoveryProblems([
          {
            file: "tests/broken.test.yaml",
            line: 4,
            col: 3,
            code: "invalid_yaml",
            message: "Unexpected end of mapping.",
            fix: "Close the mapping on line 4.",
          },
        ]);
        await recorder.finish({
          code: "discovery_error",
          message: "1 test file or path problem(s) were found.",
        });
      },
    ),
  frames: () =>
    record("run-frames", [
      {
        file: cart,
        attempts: [
          [
            step(cart, 1, "failed_verify", {
              evidence: { status: "omitted", reason: "sensitive_page" },
            }),
            step(cart, 2, "low_confidence", {
              evidence: { status: "unavailable", reason: "frame_size" },
            }),
          ],
        ],
      },
    ]),
  hostile: async () => {
    const marker = "[[ATTACHMENT|/etc/passwd]]";
    const triple = "[[[ATTACHMENT|/etc/passwd]]";
    return record("run-hostile", [
      {
        file: "tests/[[ATTACHMENT|x]].test.yaml",
        description: `Title ${marker} <script>&amp; ]]> [[[[`,
        tags: [triple],
        attempts: [
          [
            step("tests/[[ATTACHMENT|x]].test.yaml", 1, "failed_action", {
              sentence: `click ${triple} & <b>`,
              detail: `detail ${marker}\u0007\u0001`,
              page: {
                status: "available",
                observationId: "hostile:observation",
                url: "https://shop.test/[[ATTACHMENT|/etc/passwd]]",
                title: `Title ${triple} "quoted" 'single'`,
              },
              error: {
                code: "ambiguous",
                message: `message ${marker} \uD800 lone surrogate`,
                callLog: [triple, "[[[["],
              },
            }),
          ],
        ],
      },
    ]);
  },
};

/** A valid result with a test that has no attempts, which the CLI never writes. */
export async function unexecutedTest(): Promise<RunResult> {
  const base = await fixtures.clean();
  const tests = [
    ...base.tests,
    {
      id: "test:never",
      file: "tests/never.test.yaml",
      description: "",
      tags: [],
      state: "interrupted" as const,
      verdict: null,
      flags: [],
      selectedAttemptId: null,
      attempts: [],
    },
  ];
  return validateRunResult({
    ...base,
    state: "interrupted",
    verdict: null,
    error: { code: "canceled", message: "The run was interrupted." },
    tests,
    totals: resultTotals(tests, base.setupCalls, tests.length),
    selectedTestCount: tests.length,
  });
}
