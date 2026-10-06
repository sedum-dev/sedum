import { expect, it } from "vitest";
import { buildRelevanceBatches } from "./relevance.js";

const test = { file: "suite.test.ts", source: "complete source", modules: [] };
const request = (diff: string, questions: Record<string, unknown>) => ({
  diff,
  questions,
});
const limits = { pair: 1800, batch: 3600, questions: 64 };
const build = (diff: string) =>
  buildRelevanceBatches(diff, [test], request, limits);

it("keeps a small diff intact and includes complete test/module source", () => {
  const tests = [
    { ...test, modules: [{ file: "setup", source: "all setup" }] },
  ];
  const batches = buildRelevanceBatches("small patch", tests, request, limits);
  expect(batches).toEqual([
    {
      request: {
        diff: "small patch",
        questions: {
          test0: expect.objectContaining({
            instructions: expect.objectContaining({ test: tests[0] }),
          }),
        },
      },
      indexes: [0],
      chunkIndex: 0,
    },
  ]);
  expect(buildRelevanceBatches("", [], request, limits)).toEqual([]);
  expect(buildRelevanceBatches("", [test], request, limits)).toEqual([]);
});

it("preserves every change across files, hunks and line splits with path context", () => {
  const header =
    "diff --git a/cart.ts b/cart.ts\n--- a/cart.ts\n+++ b/cart.ts\n";
  const hunk = "@@ -1,90 +1,90 @@\n";
  const lines = Array.from(
    { length: 90 },
    (_, i) => `+change-${i}: ${"x".repeat(50)}\n`,
  );
  const second =
    "diff --git a/shared.ts b/shared.ts\n--- a/shared.ts\n+++ b/shared.ts\n@@ -1 +1 @@\n+shared dependency\n";
  const chunks = build(header + hunk + lines.join("") + second);
  expect(chunks.length).toBeGreaterThan(2);
  const wire = chunks.map((chunk) => chunk.request.diff).join("");
  for (const line of lines) expect(wire.split(line)).toHaveLength(2);
  expect(wire).toContain(second);
  for (const chunk of chunks) {
    expect(
      Buffer.byteLength(JSON.stringify(chunk.request)),
    ).toBeLessThanOrEqual(limits.pair);
    if (chunk.request.diff.includes("+change-")) {
      expect(chunk.request.diff).toContain("b/cart.ts");
      expect(chunk.request.diff).toContain(hunk);
    }
  }
});

it("splits a giant escaped Unicode line without dropping payload or cutting a surrogate pair", () => {
  const original = '+"🪴\\界"'.repeat(1000);
  const chunks = build(original);
  const restored = chunks
    .map((chunk) =>
      chunk.request.diff.replace("[sedum line continuation]\n", ""),
    )
    .join("");
  expect(restored).toBe(original);
  for (const chunk of chunks) {
    expect(
      Buffer.byteLength(JSON.stringify(chunk.request)),
    ).toBeLessThanOrEqual(limits.pair);
    expect(chunk.request.diff).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  }
});

it("honors pair and batch byte boundaries and the independent question cap", () => {
  const diff = "a".repeat(30);
  const baseline = build(diff)[0]!.request;
  const bytes = Buffer.byteLength(JSON.stringify(baseline));
  expect(
    buildRelevanceBatches(diff, [test], request, { ...limits, pair: bytes }),
  ).toHaveLength(1);
  expect(
    buildRelevanceBatches(diff, [test], request, { ...limits, pair: bytes - 1 })
      .length,
  ).toBeGreaterThan(1);
  const many = Array.from({ length: 65 }, (_, i) => ({
    ...test,
    file: `test-${i}`,
  }));
  const batches = buildRelevanceBatches("diff", many, request, {
    pair: 28_000,
    batch: 1_000_000,
    questions: 64,
  });
  expect(batches.map((chunk) => chunk.indexes.length)).toEqual([64, 1]);
  expect(batches.flatMap((chunk) => chunk.indexes)).toEqual(
    Array.from({ length: 65 }, (_, i) => i),
  );
  expect(
    buildRelevanceBatches("diff", many.slice(0, 4), request, limits).every(
      (chunk) =>
        Buffer.byteLength(JSON.stringify(chunk.request)) <= limits.batch,
    ),
  ).toBe(true);
});

it("refuses impossible test/context pairs and more than 256 preflight requests", () => {
  expect(() => build("x".repeat(400_000))).toThrow("256-request");
  expect(() =>
    buildRelevanceBatches(
      "diff",
      [{ ...test, source: "界".repeat(1000) }],
      request,
      limits,
    ),
  ).toThrow("suite.test.ts");
  expect(() =>
    buildRelevanceBatches("longer than allowance", [test], request, {
      ...limits,
      pair:
        Buffer.byteLength(
          JSON.stringify(
            request("", { test0: build("x")[0]!.request.questions.test0 }),
          ),
        ) + 2,
    }),
  ).toThrow("not truncated");
  const many = Array.from({ length: 257 }, () => test);
  expect(
    buildRelevanceBatches("diff", many.slice(0, 256), request, {
      ...limits,
      questions: 1,
    }),
  ).toHaveLength(256);
  expect(() =>
    buildRelevanceBatches("diff", many, request, { ...limits, questions: 1 }),
  ).toThrow("256-request");
});

it("keeps multiple hunks and a non-newline tail intact", () => {
  const prefix =
    "diff --git a/shared.ts b/shared.ts\n--- a/shared.ts\n+++ b/shared.ts\n";
  const first = `@@ -1 +1 @@\n-${"old".repeat(400)}\n+new\n`;
  const second = `@@ -50 +50 @@\n+${"tail".repeat(500)}`;
  const wire = build(prefix + first + second)
    .map((chunk) => chunk.request.diff)
    .join("");
  expect(wire).toContain("+new\n");
  expect(wire).toContain("@@ -50 +50 @@");
  const restored = wire
    .split(prefix)
    .join("")
    .split("@@ -1 +1 @@\n")
    .join("")
    .split("@@ -50 +50 @@\n")
    .join("")
    .split("[sedum hunk continuation]\n")
    .join("")
    .split("[sedum line continuation]\n")
    .join("");
  expect(restored).toBe(`-${"old".repeat(400)}\n+new\n+${"tail".repeat(500)}`);
});
