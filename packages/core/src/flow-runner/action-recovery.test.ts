import { describe, expect, it, vi } from "vitest";
import { StepExecutionError } from "../step-executor.js";
import { pendingTarget, performWithRecovery } from "./action-recovery.js";

const refusal = (code: "stale" | "not_actionable") =>
  new StepExecutionError("click", code, "pre_dispatch");

describe("safe action recovery", () => {
  it("polls readiness, re-resolves changed snapshots, and dispatches only once", async () => {
    const perform = vi
      .fn()
      .mockRejectedValueOnce(refusal("not_actionable"))
      .mockRejectedValueOnce(refusal("stale"))
      .mockRejectedValueOnce(refusal("stale"))
      .mockResolvedValue(undefined);
    const refresh = vi.fn(async () => true);
    await performWithRecovery({
      op: "click",
      perform,
      refresh,
      allowed: () => true,
    });
    expect(perform).toHaveBeenCalledTimes(4);
    expect(refresh).toHaveBeenCalledTimes(2);
    const budgets = perform.mock.calls.map(([budget]) => budget as number);
    expect(budgets[3]).toBeLessThan(budgets[0]! - 200);
  });

  it("expires permanent refusal with the last reason and wait diagnostics", async () => {
    const perform = vi.fn().mockRejectedValue(refusal("not_actionable"));
    const refresh = vi.fn();
    const started = performance.now();
    await expect(
      performWithRecovery({
        op: "click",
        perform,
        refresh,
        timeoutMs: 250,
        allowed: () => true,
      }),
    ).rejects.toMatchObject({
      code: "not_actionable",
      retryable: true,
      message: expect.stringMatching(/after waiting \d+ ms/),
      callLog: [expect.stringContaining("no input dispatched")],
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
    expect(refresh).not.toHaveBeenCalled();
    expect(perform.mock.calls.length).toBeGreaterThan(1);
  });

  it("does not dispatch if re-resolution consumes the remaining budget", async () => {
    const perform = vi.fn().mockRejectedValue(refusal("stale"));
    const refresh = vi.fn(async (_remaining: number, signal: AbortSignal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return true;
    });
    await expect(
      performWithRecovery({
        op: "click",
        perform,
        refresh,
        timeoutMs: 200,
        allowed: () => true,
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("stops on cancellation during a readiness wait", async () => {
    const controller = new AbortController();
    const perform = vi.fn(async () => {
      controller.abort();
      throw refusal("not_actionable");
    });
    await expect(
      performWithRecovery({
        op: "click",
        perform,
        refresh: vi.fn(),
        allowed: () => true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "canceled" });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("never replays an uncertain action, even after an earlier safe refusal", async () => {
    const uncertain = new StepExecutionError(
      "click",
      "action_uncertain",
      "post_dispatch",
    );
    const perform = vi
      .fn()
      .mockRejectedValueOnce(refusal("not_actionable"))
      .mockRejectedValue(uncertain);
    await expect(
      performWithRecovery({
        op: "click",
        perform,
        refresh: vi.fn(),
        allowed: () => true,
      }),
    ).rejects.toBe(uncertain);
    expect(perform).toHaveBeenCalledTimes(2);
  });

  it("does not retry a vision target", async () => {
    const error = refusal("stale");
    const perform = vi.fn().mockRejectedValue(error);
    await expect(
      performWithRecovery({
        op: "click",
        perform,
        refresh: vi.fn(),
        allowed: () => false,
      }),
    ).rejects.toBe(error);
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("stops when re-resolution uses vision and abstains", async () => {
    let allowed = true;
    const error = refusal("stale");
    const perform = vi.fn().mockRejectedValue(error);
    const refresh = vi.fn(async () => {
      allowed = false;
      return false;
    });
    await expect(
      performWithRecovery({
        op: "click",
        perform,
        refresh,
        allowed: () => allowed,
      }),
    ).rejects.toBe(error);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("pending target", () => {
  it.each([
    ["low_confidence_or_margin", "(no match)", 0.49, true],
    ["low_confidence_or_margin", "Other button", 0.49, false],
    ["repeated_member_no_evidence", "(no match)", 0.49, false],
    ["low_confidence_or_margin", "(no match)", 0.1, false],
  ])(
    "keeps ambiguity gates: %s / %s / %s",
    (gate, name, probability, pending) => {
      expect(
        pendingTarget({
          kind: "unresolved",
          reason: "ambiguous",
          calls: [],
          diagnostic: {
            candidateCount: 1,
            rounds: 1,
            gate,
            topOptions: [
              { name: "Old screen", role: "button", probability: 0.51 },
              { name, role: "", probability },
            ],
          },
        }),
      ).toBe(pending);
    },
  );
});
