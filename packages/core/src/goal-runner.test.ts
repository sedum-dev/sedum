import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runGoal,
  goalChoiceAccepted,
  goalOperations,
  type GoalChoice,
  type GoalAction,
  type GoalPlanner,
  type GoalState,
} from "./goal-runner.js";
import { collectCandidates, pageDigest, pageVersion } from "./page-bridge.js";
import { verify } from "./assertion-engine.js";
import {
  executeStep,
  RuntimeValue,
  StepExecutionError,
} from "./step-executor.js";
import type { BrowserPage } from "./browser-driver.js";
import type { Judge, ProviderCall } from "./provider.js";

vi.mock("./page-bridge.js");
vi.mock("./assertion-engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assertion-engine.js")>()),
  verify: vi.fn(),
}));
vi.mock("./step-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./step-executor.js")>()),
  executeStep: vi.fn(),
}));
const version = { document: "d", revision: 1, route: "/" };
const call: ProviderCall = {
  model: "test",
  requestedModel: "test",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};
const choose = (choice: string, ids: string[]): GoalChoice => ({
  choice,
  confidence: 0.9,
  probabilities: Object.fromEntries(
    ids.map((id) => [id, id === choice ? 1 : 0]),
  ),
});
const page = { evaluate: vi.fn(async () => []) } as unknown as BrowserPage;
const judge = {} as Judge;
const options = { goal: "Open destination", verify: ["Destination is open"] };
function planner(op: string): GoalPlanner {
  return {
    chooseGoal: vi.fn(async (state: GoalState) => ({
      operation: choose(op, Object.keys(goalOperations(state))),
      ...(op === "CLICK"
        ? { target: choose("c0", Object.keys(state.targets.CLICK!)) }
        : {}),
      call,
    })),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pageVersion).mockResolvedValue(version);
  vi.mocked(pageDigest).mockResolvedValue({
    protocol: 1,
    version,
    text: "Start",
    complete: true,
  });
  vi.mocked(collectCandidates).mockImplementation(async (_page, op) => ({
    protocol: 1,
    version,
    total: op === "click" ? 1 : 0,
    offset: 0,
    next: null,
    complete: true,
    candidates:
      op === "click"
        ? [
            {
              ref: "a",
              tag: "button",
              role: "button",
              name: "Open",
              peers: [],
              editable: false,
              disabled: false,
              inputType: "",
              signals: { path: "button" },
            },
          ]
        : [],
  }));
  vi.mocked(executeStep).mockResolvedValue({
    op: "click",
    outcome: "acted",
    elapsedMs: 1,
  });
});
describe("bounded goal runner", () => {
  it("relaxes only operation margin, retaining target and confidence gates", async () => {
    const model = planner("CLICK");
    const implementation = vi.mocked(model.chooseGoal).getMockImplementation()!;
    vi.mocked(model.chooseGoal).mockImplementation(async (...args) => ({
      ...(await implementation(...args)),
      operation: {
        choice: "CLICK",
        confidence: 0.8,
        probabilities: { CLICK: 0.52, DONE: 0.48, BLOCKED: 0 },
      },
    }));
    expect(await runGoal(page, model, judge, options)).toMatchObject({
      reason: "operation_abstention",
      actions: 0,
    });
    expect(
      await runGoal(page, model, judge, {
        ...options,
        operationMinMargin: 0.03,
        maxActions: 1,
      }),
    ).toMatchObject({ reason: "action_limit", actions: 1 });
    vi.mocked(model.chooseGoal).mockImplementation(async (...args) => ({
      ...(await implementation(...args)),
      target: { choice: "c0", confidence: 0.29, probabilities: { c0: 1 } },
    }));
    expect(
      await runGoal(page, model, judge, {
        ...options,
        operationMinMargin: 0.03,
      }),
    ).toMatchObject({ reason: "target_abstention", actions: 0 });
    const ambiguous = {
      choice: "a",
      confidence: 0.8,
      probabilities: { a: 0.52, b: 0.48 },
    };
    expect(goalChoiceAccepted(ambiguous, ["a", "b"])).toBe(false);
    expect(goalChoiceAccepted(ambiguous, ["a", "b"], 0.03)).toBe(true);
    expect(
      goalChoiceAccepted({ ...ambiguous, confidence: 0.29 }, ["a", "b"], 0.03),
    ).toBe(false);
    expect(
      goalChoiceAccepted(
        { ...ambiguous, probabilities: { a: 0.51, b: 0.49 } },
        ["a", "b"],
        0.03,
      ),
    ).toBe(false);
  });
  it.each([-1, 1.1, NaN, Infinity])(
    "rejects invalid operation margin %s",
    async (operationMinMargin) => {
      await expect(
        runGoal(page, planner("CLICK"), judge, {
          ...options,
          operationMinMargin,
        }),
      ).rejects.toThrow("Invalid goal operation margin");
    },
  );
  it.each([false, true])(
    "DONE cannot pass a failed or flagged independent assertion (flagged=%s)",
    async (flagged) => {
      vi.mocked(verify).mockResolvedValue({
        kind: "verify",
        verdict: flagged ? "passed" : "failed",
        flags: flagged ? ["low_confidence"] : [],
        holds: flagged ? 0.68 : 0.1,
        contradicted: flagged ? 0.07 : 0.9,
        call,
        elapsedMs: 1,
        observationVersion: version,
        minP: 0.75,
        band: 0.15,
        contradictionCutoff: 0.5,
      });
      const result = await runGoal(page, planner("DONE"), judge, options);
      expect(result).toMatchObject({
        status: "failed",
        reason: "verification_failed",
        requests: 2,
        actions: 0,
      });
      expect(verify).toHaveBeenCalledOnce();
      expect(executeStep).not.toHaveBeenCalled();
    },
  );
  it("cannot pass DONE when no budget remains for verification", async () => {
    expect(
      await runGoal(page, planner("DONE"), judge, {
        ...options,
        maxRequests: 1,
      }),
    ).toMatchObject({ reason: "request_limit", status: "failed" });
    expect(verify).not.toHaveBeenCalled();
  });
  it("stops on unchanged state instead of clicking forever", async () => {
    expect(await runGoal(page, planner("CLICK"), judge, options)).toMatchObject(
      { reason: "no_progress", actions: 3, requests: 3 },
    );
    expect(executeStep).toHaveBeenCalledTimes(3);
  });
  it("never replays a dispatched action with uncertain outcome", async () => {
    vi.mocked(executeStep).mockRejectedValue(
      new StepExecutionError("click", "action_uncertain", "post_dispatch"),
    );
    const onAction = vi.fn(async () => {});
    const result = await runGoal(page, planner("CLICK"), judge, {
      ...options,
      onAction,
    });
    expect(result).toMatchObject({
      reason: "action_uncertain:post_dispatch",
      actions: 1,
      requests: 1,
    });
    expect(result.history).toHaveLength(1);
    expect(executeStep).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "click",
        status: "failed",
        reason: "action_uncertain:post_dispatch",
        calls: [call],
      }),
    );
  });
  it("streams completed actions with incremental calls, and emits nothing for abstention", async () => {
    const onAction = vi.fn(async (action: GoalAction) => {
      expect(executeStep).toHaveBeenCalled();
      expect(action.status).toBe("passed");
    });
    const result = await runGoal(page, planner("CLICK"), judge, {
      ...options,
      onAction,
    });
    expect(result.reason).toBe("no_progress");
    expect(onAction).toHaveBeenCalledTimes(3);
    for (const [action] of onAction.mock.calls) {
      expect(action).toMatchObject({
        operation: "click",
        sentence: "Click Open",
        status: "passed",
        reason: null,
        calls: [call],
      });
    }
    onAction.mockClear();
    await runGoal(page, planner("BLOCKED"), judge, { ...options, onAction });
    expect(onAction).not.toHaveBeenCalled();
  });
  it("stops instead of dispatching again after a reporting failure", async () => {
    const onAction = vi.fn(async () => {
      throw new Error("report sink unavailable");
    });
    const result = await runGoal(page, planner("CLICK"), judge, {
      ...options,
      onAction,
    });
    expect(result.status).toBe("failed");
    expect(executeStep).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledOnce();
  });
  it("redacts quoted secret echoes before serialization and ignores target data for BLOCKED", async () => {
    const secret = 'a"quoted\\secret';
    vi.mocked(pageDigest).mockResolvedValue({
      protocol: 1,
      version,
      text: `Echo ${secret}`,
      complete: true,
    });
    const model = planner("BLOCKED");
    const result = await runGoal(page, model, judge, {
      ...options,
      goal: `Use ${secret}`,
      data: { password: { value: new RuntimeValue(secret), sensitive: true } },
    });
    const state = vi.mocked(model.chooseGoal).mock.calls[0]![0];
    expect(state.page).toBe("Echo [sensitive]");
    expect(state.goal).toBe("Use [sensitive]");
    expect(JSON.stringify(result)).not.toContain("quoted");
    expect(result.reason).toBe("blocked");
  });
  it("enforces action and request budgets separately", async () => {
    expect(
      await runGoal(page, planner("CLICK"), judge, {
        ...options,
        maxActions: 1,
      }),
    ).toMatchObject({ reason: "action_limit", actions: 1, requests: 2 });
    expect(
      await runGoal(page, planner("CLICK"), judge, {
        ...options,
        maxRequests: 1,
      }),
    ).toMatchObject({ reason: "request_limit", actions: 1, requests: 1 });
  });
  it("bounds a hung provider by wall time without dispatching", async () => {
    const model: GoalPlanner = { chooseGoal: () => new Promise(() => {}) };
    const result = await runGoal(page, model, judge, {
      ...options,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({ reason: "timeout", actions: 0 });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.totalCostUsd).toBeNull();
    expect(executeStep).not.toHaveBeenCalled();
  });
  it("rejects changed candidate identity even if a page keeps its version", async () => {
    const original = vi.mocked(collectCandidates).getMockImplementation()!;
    let clicks = 0;
    vi.mocked(collectCandidates).mockImplementation(async (...args) => {
      const snapshot = await original(...args);
      if (args[1] === "click" && ++clicks > 1)
        return {
          ...snapshot,
          candidates: snapshot.candidates.map((c) => ({
            ...c,
            name: "Delete",
          })),
        };
      return snapshot;
    });
    expect(await runGoal(page, planner("CLICK"), judge, options)).toMatchObject(
      { reason: "stale_observation", actions: 0 },
    );
    expect(executeStep).not.toHaveBeenCalled();
  });
  it("does not offer clicks outside the host-authored allowlist", async () => {
    const model = planner("BLOCKED");
    await runGoal(page, model, judge, {
      ...options,
      allowedClickNames: ["Read"],
    });
    expect(vi.mocked(model.chooseGoal).mock.calls[0]![0].targets).toEqual({});
    expect(executeStep).not.toHaveBeenCalled();
  });
  it("rejects low confidence, low margin, incoherent and cross-head distributions", () => {
    expect(
      goalChoiceAccepted(
        { choice: "a", confidence: 0.29, probabilities: { a: 0.8, b: 0.2 } },
        ["a", "b"],
      ),
    ).toBe(false);
    expect(
      goalChoiceAccepted(
        { choice: "a", confidence: 0.9, probabilities: { a: 0.54, b: 0.46 } },
        ["a", "b"],
      ),
    ).toBe(false);
    expect(
      goalChoiceAccepted(
        { choice: "a", confidence: 0.9, probabilities: { a: 0.9, b: 0.2 } },
        ["a", "b"],
      ),
    ).toBe(false);
    expect(goalChoiceAccepted(choose("x", ["x"]), ["a", "b"])).toBe(false);
    expect(
      goalChoiceAccepted(
        { choice: "a", confidence: 0.3, probabilities: { a: 0.56, b: 0.44 } },
        ["a", "b"],
      ),
    ).toBe(true);
  });
});
