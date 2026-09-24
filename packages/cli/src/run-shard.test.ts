import { describe, expect, it } from "vitest";
import { shardItems, shardProblems, shardTests } from "./run-shard.js";

/** Small deterministic PRNG so the property checks are reproducible. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function suite(size: number, random: () => number) {
  return Array.from({ length: size }, (_, index) => ({
    id: `tests/${Math.floor(random() * 1e9).toString(36)}-${index}.test.yaml`,
  }));
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function assignment(tests: readonly { id: string }[], count: number) {
  const owner = new Map<string, number>();
  for (let index = 1; index <= count; index++)
    for (const test of shardTests(tests, { index, count }))
      owner.set(test.id, index);
  return owner;
}

describe("shardTests", () => {
  it("partitions every selection exactly, balanced within one test", () => {
    const random = prng(34);
    for (let round = 0; round < 200; round++) {
      const size = Math.floor(random() * 501);
      const count = 1 + Math.floor(random() * 16);
      const tests = suite(size, random);
      const shards = Array.from({ length: count }, (_, index) =>
        shardTests(tests, { index: index + 1, count }),
      );
      const ids = shards.flat().map((test) => test.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...ids].sort()).toEqual(tests.map((test) => test.id).sort());
      const sizes = shards.map((shard) => shard.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  });

  it("does not depend on discovery order", () => {
    const random = prng(7);
    for (let round = 0; round < 50; round++) {
      const tests = suite(1 + Math.floor(random() * 200), random);
      const count = 1 + Math.floor(random() * 8);
      expect(assignment(shuffle(tests, random), count)).toEqual(
        assignment(tests, count),
      );
    }
  });

  it("moves at most count - 1 existing tests when one is added or removed", () => {
    const random = prng(99);
    for (let round = 0; round < 200; round++) {
      const tests = suite(Math.floor(random() * 300), random);
      const count = 1 + Math.floor(random() * 16);
      const before = assignment(tests, count);
      const added = assignment(
        [...tests, { id: `tests/new-${round}.test.yaml` }],
        count,
      );
      const moved = tests.filter(
        (test) => before.get(test.id) !== added.get(test.id),
      ).length;
      expect(moved).toBeLessThanOrEqual(count - 1);
      if (tests.length === 0) continue;
      const removedId = tests[Math.floor(random() * tests.length)]!.id;
      const removed = assignment(
        tests.filter((test) => test.id !== removedId),
        count,
      );
      const movedAfterRemoval = tests.filter(
        (test) =>
          test.id !== removedId && before.get(test.id) !== removed.get(test.id),
      ).length;
      expect(movedAfterRemoval).toBeLessThanOrEqual(count - 1);
    }
  });

  it("keeps a known assignment stable across releases", () => {
    const tests = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
    expect(
      [1, 2].map((index) =>
        shardTests(tests, { index, count: 2 }).map((test) => test.id),
      ),
    ).toMatchInlineSnapshot(`
      [
        [
          "d",
          "e",
        ],
        [
          "c",
          "a",
          "b",
        ],
      ]
    `);
  });

  it("leaves shards empty when there are more shards than tests", () => {
    const tests = [{ id: "one" }, { id: "two" }];
    const sizes = [1, 2, 3, 4].map(
      (index) => shardTests(tests, { index, count: 4 }).length,
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(2);
    expect(sizes.filter((size) => size === 0)).toHaveLength(2);
    expect(shardTests([], { index: 1, count: 1 })).toEqual([]);
  });

  it("rejects invalid shard specs", () => {
    for (const shard of [
      { index: 0, count: 2 },
      { index: 3, count: 2 },
      { index: 1, count: 0 },
      { index: 1.5, count: 2 },
      { index: 1, count: Number.NaN },
    ])
      expect(() => shardItems([1], String, shard)).toThrow(RangeError);
  });

  it("orders equal hashes by key so duplicates stay deterministic", () => {
    const items = ["x", "x", "x"];
    expect(shardItems(items, (item) => item, { index: 1, count: 1 })).toEqual(
      items,
    );
  });
});

describe("shardProblems", () => {
  it("gives each problem file to exactly one shard, keeping all its problems together", () => {
    const problems = [
      { file: "tests/bad-a.test.yaml", code: "one" },
      { file: "tests/bad-a.test.yaml", code: "two" },
      { file: "tests/bad-b.test.yaml", code: "three" },
      { file: "tests/bad-c.test.yaml", code: "four" },
    ];
    const count = 3;
    const shards = Array.from({ length: count }, (_, index) =>
      shardProblems(problems, { index: index + 1, count }),
    );
    expect(shards.flat()).toHaveLength(problems.length);
    for (const shard of shards) {
      const files = new Set(shard.map((problem) => problem.file));
      for (const file of files)
        expect(shard.filter((problem) => problem.file === file)).toEqual(
          problems.filter((problem) => problem.file === file),
        );
    }
  });
});
