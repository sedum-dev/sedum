import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GateAborted,
  GateWaitExceeded,
  MAX_COOLDOWN_MS,
  ProviderGate,
  backoffDelay,
  cooldownDelay,
  nextConcurrency,
  parseRetryAfter,
} from "./gate.js";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");

  it("prefers retry-after-ms, then seconds, then an HTTP date", () => {
    expect(
      parseRetryAfter(
        new Headers({ "retry-after-ms": "1500.2", "retry-after": "9" }),
        now,
      ),
    ).toBe(1501);
    expect(parseRetryAfter(new Headers({ "retry-after": "2" }), now)).toBe(
      2000,
    );
    expect(parseRetryAfter(new Headers({ "retry-after": "0.5" }), now)).toBe(
      500,
    );
    expect(
      parseRetryAfter(
        new Headers({ "retry-after": "Wed, 23 Sep 2026 12:00:45 GMT" }),
        now,
      ),
    ).toBe(45_000);
  });

  it("clamps past dates to zero and rejects missing or malformed values", () => {
    expect(
      parseRetryAfter(
        new Headers({ "retry-after": "Wed, 23 Sep 2026 11:00:00 GMT" }),
        now,
      ),
    ).toBe(0);
    expect(parseRetryAfter(new Headers(), now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(
      parseRetryAfter(new Headers({ "retry-after": "soon" }), now),
    ).toBeNull();
    expect(
      parseRetryAfter(new Headers({ "retry-after": "-3" }), now),
    ).toBeNull();
    expect(
      parseRetryAfter(new Headers({ "retry-after-ms": "abc" }), now),
    ).toBeNull();
  });
});

describe("backoff and cooldown delays", () => {
  it("doubles per failure, subtracts at most a quarter, and caps one window", () => {
    expect(backoffDelay(1, 500, 0)).toBe(500);
    expect(backoffDelay(2, 500, 0)).toBe(1000);
    expect(backoffDelay(3, 500, 1)).toBe(1500);
    expect(backoffDelay(0, 500, 0)).toBe(500);
    expect(backoffDelay(30, 500, 0)).toBe(MAX_COOLDOWN_MS);
    expect(backoffDelay(1, 1, 1)).toBe(1);
  });

  it("honors a server delay, only lengthening it with jitter, capped at one window", () => {
    expect(cooldownDelay(2000, 1, 500, 0)).toBe(2000);
    expect(cooldownDelay(2000, 1, 500, 1)).toBe(2500);
    expect(cooldownDelay(45_000, 1, 500, 0)).toBe(45_000);
    expect(cooldownDelay(120_000, 1, 500, 0)).toBe(MAX_COOLDOWN_MS);
    expect(cooldownDelay(0, 1, 500, 0)).toBe(1);
    expect(cooldownDelay(null, 3, 500, 0)).toBe(2000);
  });

  it("ramps admission up by one per success and drops to one on a 429", () => {
    expect(nextConcurrency(1, 4, "success")).toBe(2);
    expect(nextConcurrency(4, 4, "success")).toBe(4);
    expect(nextConcurrency(3, 4, "rate-limited")).toBe(1);
  });
});

describe("ProviderGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  }

  it("rejects an invalid concurrency", () => {
    expect(() => new ProviderGate({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new ProviderGate({ concurrency: 33 })).toThrow(RangeError);
    expect(() => new ProviderGate({ concurrency: 1.5 })).toThrow(RangeError);
    expect(new ProviderGate().cap).toBe(4);
  });

  it("never runs more tasks than the cap and reports the queue wait", async () => {
    const gate = new ProviderGate({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const releases = Array.from({ length: 5 }, () => deferred());
    const runs = releases.map((release) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.inFlight).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    for (const release of releases) {
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    const results = await Promise.all(runs);
    expect(peak).toBe(2);
    expect(results[0]!.waitedMs).toBe(0);
    expect(results[4]!.waitedMs).toBe(1000);
  });

  it("admits nothing during a shared cooldown, then ramps back up from one", async () => {
    const gate = new ProviderGate({ concurrency: 3 });
    gate.cooldown(Date.now() + 2000);
    expect(gate.coolingDown).toBe(true);
    expect(gate.concurrency).toBe(1);
    const started: number[] = [];
    const releases = Array.from({ length: 3 }, () => deferred());
    const runs = releases.map((release) =>
      gate.run(async () => {
        started.push(Date.now());
        await release.promise;
      }),
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(1);
    expect(gate.coolingDown).toBe(false);
    releases[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The freed slot admits the next request, still one at a time.
    expect(started).toHaveLength(2);
    expect(gate.inFlight).toBe(1);
    gate.succeeded();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(3);
    expect(gate.inFlight).toBe(2);
    releases[1]!.resolve();
    releases[2]!.resolve();
    await Promise.all(runs);
    gate.succeeded();
    gate.succeeded();
    expect(gate.concurrency).toBe(3);
  });

  it("extends a cooldown to the latest requested instant and ignores earlier ones", async () => {
    const gate = new ProviderGate({ concurrency: 2 });
    const start = Date.now();
    gate.cooldown(start + 1000);
    gate.cooldown(start + 3000);
    gate.cooldown(start + 2000);
    let ran = false;
    const run = gate.run(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(ran).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(ran).toBe(true);
  });

  it("removes a queued task when its signal aborts or its wait budget ends", async () => {
    const gate = new ProviderGate({ concurrency: 1 });
    gate.cooldown(Date.now() + 10_000);
    const controller = new AbortController();
    const task = vi.fn(async () => undefined);
    const aborted = gate.run(task, { signal: controller.signal });
    const budgeted = gate.run(task, { maxWaitMs: 500 });
    const assertions = [
      expect(aborted).rejects.toBeInstanceOf(GateAborted),
      expect(budgeted).rejects.toBeInstanceOf(GateWaitExceeded),
    ];
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all(assertions);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(task).not.toHaveBeenCalled();
    await expect(
      gate.run(task, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(GateAborted);
  });

  it("releases a pending cooldown timer when closed", () => {
    const gate = new ProviderGate();
    gate.cooldown(Date.now() + 60_000);
    expect(vi.getTimerCount()).toBe(1);
    gate.close();
    expect(vi.getTimerCount()).toBe(0);
    gate.close();
  });

  it("does not report a task's own error as a wait failure", async () => {
    const gate = new ProviderGate();
    await expect(
      gate.run(
        async () => {
          throw new Error("task failed");
        },
        { maxWaitMs: 10 },
      ),
    ).rejects.toThrow("task failed");
  });
});
