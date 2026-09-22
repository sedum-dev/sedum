import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "./browser-driver.js";
import type { Aim, PageVersion } from "./page-protocol.js";
import { safeCallLog } from "./safe-diagnostics.js";
import {
  executeStep,
  ResolvedStepTarget,
  RuntimeUrl,
  RuntimeValue,
  StepExecutionError,
} from "./step-executor.js";

const version: PageVersion = {
  document: "document-1",
  revision: 1,
  route: "https://example.test/",
};
const aim: Aim = {
  ref: "ref-1",
  document: version.document,
  route: version.route,
  revision: version.revision,
  tag: "button",
  name: "Submit",
  point: { x: 10, y: 10 },
};
const clickTargetRef = new ResolvedStepTarget({
  ref: aim.ref,
  version,
  tag: aim.tag,
  name: aim.name,
});

function fakePage() {
  let current = version;
  let currentAim: unknown = { actionable: true, aim };
  let quiet = true;
  let versionErrors = 0;
  const clickRef = vi.fn(async () => ({ actionable: true as const, aim }));
  const fillRef = vi.fn(async () => ({ acted: true as const }));
  const press = vi.fn(async () => undefined);
  const scroll = vi.fn(async () => undefined);
  const goto = vi.fn(async (url: string) => ({ url }));
  const settle = vi.fn(async () => ({ settled: true, elapsedMs: 1 }));
  const evaluate = vi.fn(async (expression: string) => {
    let value: unknown;
    if (expression.includes('bridge["pageVersion"]')) {
      if (versionErrors > 0) {
        versionErrors--;
        throw new Error("Execution context was destroyed");
      }
      value = current;
    } else if (expression.includes('bridge["clickTarget"]')) value = currentAim;
    else if (expression.includes('bridge["quiet"]'))
      value = { version: current, quiet };
    return { installed: true, protocol: 1, value };
  });
  return {
    page: {
      clickRef,
      fillRef,
      press,
      scroll,
      goto,
      settle,
      evaluate,
    } as unknown as BrowserPage,
    clickRef,
    fillRef,
    press,
    scroll,
    goto,
    settle,
    setVersion(next: PageVersion) {
      current = next;
    },
    setAim(next: unknown) {
      currentAim = next;
    },
    setQuiet(next: boolean) {
      quiet = next;
    },
    failNextVersionReads(count: number) {
      versionErrors = count;
    },
  };
}

describe("step executor", () => {
  it("keeps runtime values out of string, inspection, JSON and errors", async () => {
    const secret = "SECRET%22-é-credential";
    const value = new RuntimeValue(secret, "{{password}}");
    const url = new RuntimeUrl(["https://example.test/?token=", ""], [value]);
    const command = { op: "goto" as const, url };
    const target = new ResolvedStepTarget({
      ref: "ref-secret-route",
      version: { ...version, route: `https://example.test/?token=${secret}` },
      tag: "input",
      name: "Password",
    });
    expect(String(value)).toBe("{{password}}");
    expect(inspect(command)).not.toContain(secret);
    expect(JSON.stringify(command)).not.toContain(secret);
    expect(inspect({ op: "type", target, value })).not.toContain(secret);
    expect(JSON.stringify({ op: "type", target, value })).not.toContain(secret);
    const { page, goto } = fakePage();
    goto.mockRejectedValueOnce(
      new Error(
        `Navigation failed at ${url.reveal()}\nCall log:\n  - waiting for scheduled navigations to finish\n  - goto('${secret}')`,
      ),
    );
    let failure: unknown;
    try {
      await executeStep(page, command);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(StepExecutionError);
    expect(goto).toHaveBeenCalledWith(url.reveal(), {
      timeoutMs: expect.any(Number),
      safeDiagnostics: true,
    });
    expect(inspect(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect((failure as Error).stack).not.toContain(secret);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((failure as StepExecutionError).callLog).toEqual([
      "waiting for scheduled navigations to finish",
      "[action argument redacted]",
    ]);
  });

  it("lets only argument-free Playwright call-log lines through", () => {
    const lines = safeCallLog(
      new Error(
        "secret\nCall log:\n  - element is visible, enabled and stable\n  - filling SECRET\n  - unexpected SECRET format",
      ),
    );
    expect(lines).toEqual([
      "element is visible, enabled and stable",
      "[action argument redacted]",
      "[action argument redacted]",
    ]);
  });

  it("rejects unsafe display labels and malformed URL templates", () => {
    expect(() => new RuntimeValue("secret", "secret")).toThrow(RangeError);
    expect(
      () => new RuntimeUrl(["prefix"], [new RuntimeValue("secret")]),
    ).toThrow(RangeError);
    expect(String(new RuntimeUrl(["https://example.test/"]))).toBe(
      "https://example.test/",
    );
    expect(safeCallLog(new Error("secret without a call log"))).toEqual([]);
  });

  it("rejects stale click targets before dispatch", async () => {
    const { page, clickRef, setVersion } = fakePage();
    setVersion({ ...version, revision: 2 });
    await expect(
      executeStep(page, { op: "click", target: clickTargetRef }),
    ).rejects.toMatchObject({ code: "stale", retryable: true });
    expect(clickRef).not.toHaveBeenCalled();
  });

  it("rejects an unclickable aim and a target changed between aim and action", async () => {
    const first = fakePage();
    first.setAim({ actionable: false, reason: "not_actionable" });
    await expect(
      executeStep(first.page, {
        op: "click",
        target: clickTargetRef,
      }),
    ).rejects.toMatchObject({ code: "not_actionable", retryable: true });
    expect(first.clickRef).not.toHaveBeenCalled();

    const second = fakePage();
    second.setAim({ actionable: true, aim: { ...aim, revision: 3 } });
    await expect(
      executeStep(second.page, {
        op: "click",
        target: clickTargetRef,
      }),
    ).rejects.toMatchObject({ code: "stale", retryable: true });
    expect(second.clickRef).not.toHaveBeenCalled();
  });

  it("dispatches click once and treats a possible post-dispatch failure as non-retryable", async () => {
    const { page, clickRef } = fakePage();
    clickRef.mockResolvedValueOnce({
      actionable: false,
      reason: "action_started",
      retryable: false,
      callLog: ["done scrolling"],
    } as never);
    await expect(
      executeStep(page, { op: "click", target: clickTargetRef }),
    ).rejects.toMatchObject({
      code: "action_uncertain",
      retryable: false,
      callLog: ["done scrolling"],
    });
    expect(clickRef).toHaveBeenCalledTimes(1);
  });

  it("keeps a driver refusal before click dispatch retryable", async () => {
    const { page, clickRef } = fakePage();
    clickRef.mockResolvedValueOnce({
      actionable: false,
      reason: "not_actionable",
    } as never);
    await expect(
      executeStep(page, { op: "click", target: clickTargetRef }),
    ).rejects.toMatchObject({ code: "not_actionable", retryable: true });
    clickRef.mockResolvedValueOnce({
      actionable: false,
      reason: "stale",
    } as never);
    await expect(
      executeStep(page, { op: "click", target: clickTargetRef }),
    ).rejects.toMatchObject({ code: "stale", retryable: true });
    expect(clickRef).toHaveBeenCalledTimes(2);
  });

  it("passes opaque fill values only to the driver and preserves pre-dispatch failure", async () => {
    const { page, fillRef } = fakePage();
    const rawTarget = { ref: "field", version, tag: "input", name: "Password" };
    const target = new ResolvedStepTarget(rawTarget);
    const value = new RuntimeValue("opaque-password", "{{password}}");
    const result = await executeStep(page, { op: "type", target, value });
    expect(result).toMatchObject({ op: "type", outcome: "acted" });
    expect(fillRef).toHaveBeenCalledWith(rawTarget, "opaque-password", {
      timeoutMs: expect.any(Number),
    });
    fillRef.mockResolvedValueOnce({
      acted: false,
      reason: "stale",
      retryable: true,
    } as never);
    await expect(
      executeStep(page, { op: "type", target, value }),
    ).rejects.toMatchObject({ code: "stale", retryable: true });
    expect(fillRef).toHaveBeenCalledTimes(2);
    fillRef.mockRejectedValueOnce(
      new Error(
        "fill(opaque-password)\nCall log:\n  - waiting for element to be visible, enabled and editable\n  - fill(opaque-password)",
      ),
    );
    let failure: unknown;
    try {
      await executeStep(page, { op: "type", target, value });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ retryable: false, phase: "post_dispatch" });
    expect(inspect(failure)).not.toContain("opaque-password");
    expect(JSON.stringify(failure)).not.toContain("opaque-password");
  });

  it("does not replay a click when post-action settling times out", async () => {
    const { page, clickRef, settle, setVersion } = fakePage();
    clickRef.mockImplementationOnce(async () => {
      setVersion({
        ...version,
        document: "document-2",
        route: "https://example.test/next",
      });
      return { actionable: true, aim };
    });
    settle.mockResolvedValueOnce({ settled: false, elapsedMs: 4_000 });
    await expect(
      executeStep(page, { op: "click", target: clickTargetRef }),
    ).rejects.toMatchObject({ code: "action_uncertain", retryable: false });
    expect(clickRef).toHaveBeenCalledTimes(1);
  });

  it("retries only the version read after a document race", async () => {
    const { page, press, settle, setVersion, failNextVersionReads } =
      fakePage();
    press.mockImplementationOnce(async () => {
      setVersion({
        ...version,
        document: "document-2",
        route: "https://example.test/next",
      });
      failNextVersionReads(1);
    });
    const result = await executeStep(page, { op: "press", key: "Enter" });
    expect(result.outcome).toBe("route_changed");
    expect(press).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalled();
  });

  it("does not replay after failed route quieting or an unreadable new document", async () => {
    const first = fakePage();
    first.press.mockImplementationOnce(async () => {
      first.setVersion({ ...version, route: "https://example.test/spa" });
      first.setQuiet(false);
    });
    await expect(
      executeStep(first.page, { op: "press", key: "Enter" }),
    ).rejects.toMatchObject({ code: "action_uncertain", retryable: false });
    expect(first.press).toHaveBeenCalledTimes(1);

    const second = fakePage();
    second.press.mockImplementationOnce(async () => {
      second.failNextVersionReads(2);
      return undefined;
    });
    await expect(
      executeStep(second.page, { op: "press", key: "Enter" }),
    ).rejects.toMatchObject({ code: "action_uncertain", retryable: false });
    expect(second.press).toHaveBeenCalledTimes(1);
  });

  it("preserves a pre-dispatch fill refusal and a post-dispatch fill uncertainty", async () => {
    const { page, fillRef } = fakePage();
    const target = new ResolvedStepTarget({
      ref: "field",
      version,
      tag: "input",
      name: "Password",
    });
    const value = new RuntimeValue("hidden-secret");
    fillRef.mockResolvedValueOnce({
      acted: false,
      reason: "not_actionable",
      retryable: true,
    } as never);
    await expect(
      executeStep(page, { op: "type", target, value }),
    ).rejects.toMatchObject({ code: "not_actionable", retryable: true });
    fillRef.mockResolvedValueOnce({
      acted: false,
      reason: "action_started",
      retryable: false,
      callLog: ["fill(hidden-secret)"],
    } as never);
    let failure: unknown;
    try {
      await executeStep(page, { op: "type", target, value });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "action_uncertain",
      retryable: false,
      callLog: ["[action argument redacted]"],
    });
    expect(JSON.stringify(failure)).not.toContain("hidden-secret");
    expect(fillRef).toHaveBeenCalledTimes(2);
  });

  it("observes an immediate route change after one press", async () => {
    const { page, press, setVersion } = fakePage();
    press.mockImplementationOnce(async () => {
      setVersion({
        ...version,
        route: "https://example.test/next",
        revision: 2,
      });
    });
    const result = await executeStep(page, { op: "press", key: "Enter" });
    expect(result.outcome).toBe("route_changed");
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch invalid wheel, key, or truncated wait", async () => {
    const { page, scroll, press } = fakePage();
    await expect(
      executeStep(page, { op: "scroll", deltaY: Infinity }),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: true });
    await expect(
      executeStep(page, { op: "press", key: " " }),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: true });
    await expect(
      executeStep(page, { op: "wait", durationMs: 100 }, { timeoutMs: 10 }),
    ).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(scroll).not.toHaveBeenCalled();
    expect(press).not.toHaveBeenCalled();
  });

  it("runs one wheel and a requested explicit wait", async () => {
    const { page, scroll } = fakePage();
    await executeStep(page, { op: "scroll", deltaY: -240 });
    expect(scroll).toHaveBeenCalledTimes(1);
    const result = await executeStep(page, { op: "wait", durationMs: 5 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(4);
  });
});
