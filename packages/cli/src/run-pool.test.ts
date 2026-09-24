import { describe, expect, it } from "vitest";
import { MAX_PARALLEL, parseParallel, planLanes, runPool } from "./run-pool.js";

describe("planLanes", () => {
  it("uses half the cores for auto, never more lanes than tests, at least one", () => {
    expect(planLanes("auto", 8, 20)).toBe(4);
    expect(planLanes("auto", 1, 20)).toBe(1);
    expect(planLanes("auto", 16, 3)).toBe(3);
    expect(planLanes(6, 2, 20)).toBe(6);
    expect(planLanes(6, 2, 0)).toBe(1);
    expect(planLanes("auto", 1024, 1000)).toBe(MAX_PARALLEL);
  });
});

describe("parseParallel", () => {
  it("accepts auto and integers from 1 to the maximum", () => {
    expect(parseParallel("auto")).toBe("auto");
    expect(parseParallel("1")).toBe(1);
    expect(parseParallel(String(MAX_PARALLEL))).toBe(MAX_PARALLEL);
    for (const value of ["0", "-1", "1.5", "01", "", "AUTO", "65", "2x"])
      expect(parseParallel(value)).toBeNull();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("runPool", () => {
  it("never exceeds the lane count and runs every item exactly once", async () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    const lanesBusy = new Set<number>();
    await runPool({
      items,
      lanes: 4,
      run: async (item, lane, ordinal) => {
        expect(lanesBusy.has(lane)).toBe(false);
        lanesBusy.add(lane);
        expect(ordinal).toBe(item);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, (item % 3) * 2));
        seen.push(item);
        active--;
        lanesBusy.delete(lane);
        return "continue";
      },
    });
    expect(peak).toBe(4);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
  });

  it("behaves as the legacy sequential loop with one lane", async () => {
    const order: string[] = [];
    await runPool({
      items: ["a", "b", "c"],
      lanes: 1,
      run: async (item, lane) => {
        order.push(`${item}@${lane}`);
        return "continue";
      },
    });
    expect(order).toEqual(["a@0", "b@0", "c@0"]);
  });

  it("stops scheduling after a stop request but lets in-flight items finish", async () => {
    const gates = [deferred(), deferred()];
    const finished: number[] = [];
    const started: number[] = [];
    const pool = runPool({
      items: [0, 1, 2, 3, 4],
      lanes: 2,
      run: async (item) => {
        started.push(item);
        if (item < 2) await gates[item]!.promise;
        finished.push(item);
        return item === 0 ? "stop" : "continue";
      },
    });
    gates[0]!.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    gates[1]!.resolve();
    await pool;
    expect(started).toEqual([0, 1]);
    expect(finished.sort()).toEqual([0, 1]);
  });

  it("stops scheduling on abort", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    await runPool({
      items: [0, 1, 2, 3],
      lanes: 2,
      signal: controller.signal,
      run: async (item) => {
        started.push(item);
        controller.abort();
        return "continue";
      },
    });
    expect(started.length).toBeLessThanOrEqual(2);
  });

  it("rethrows the first failure after every lane settles", async () => {
    const slow = deferred();
    let slowFinished = false;
    const pool = runPool({
      items: [0, 1, 2],
      lanes: 2,
      run: async (item) => {
        if (item === 0) throw new Error("first");
        await slow.promise;
        slowFinished = true;
        throw new Error("second");
      },
    });
    const assertion = expect(pool).rejects.toThrow("first");
    slow.resolve();
    await assertion;
    expect(slowFinished).toBe(true);
  });

  it("handles an empty item list", async () => {
    let calls = 0;
    await runPool({
      items: [],
      lanes: 4,
      run: async () => {
        calls++;
        return "continue";
      },
    });
    expect(calls).toBe(0);
  });
});
