import { expect, it, vi } from "vitest";
import { ClefAdapter } from "./index.js";
import { buildRelevanceRequests } from "./relevance.js";

const accountId = "0123456789abcdef0123456789abcdef";
const tests = [
  { file: "large.test.ts", source: "x".repeat(15_500), modules: [] },
];
const diff = Array.from(
  { length: 3 },
  (_, i) =>
    `diff --git a/ui${i}.ts b/ui${i}.ts\n@@ -1 +1 @@\n+${"x".repeat(9000)}\n`,
).join("");
const response = (answers: Record<string, unknown>) =>
  new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        model: "clef",
        usage: { input_tokens: 100, output_tokens: 3 },
        answers,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );

it("preflights all bounded requests, preserves source, aggregates max and rejects late failures", async () => {
  const chunks = buildRelevanceRequests(diff, tests, "clef");
  expect(chunks).toHaveLength(3);
  for (const chunk of chunks) {
    expect(
      Buffer.byteLength(JSON.stringify(chunk.request)),
    ).toBeLessThanOrEqual(28_000);
    expect(chunk.request.questions.test0!.instructions).toMatchObject({
      test: tests[0],
    });
  }
  const values = [0.12, 0.77, 0.31];
  const fetch = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(
        chunks[fetch.mock.calls.length - 1]!.request,
      );
      return response({
        test0: { type: "noul", noul: values[fetch.mock.calls.length - 1] },
      });
    },
  );
  const adapter = new ClefAdapter({
    accountId,
    apiKey: "test",
    model: "clef",
    fetch,
  });
  const got = await adapter.scoreRelevance(diff, tests);
  expect(got).toMatchObject({ probabilities: [0.77], chunkCount: 3 });
  expect(got.calls).toHaveLength(3);
  fetch.mockClear();
  fetch.mockImplementation(async () =>
    response(
      fetch.mock.calls.length === 1
        ? { test0: { type: "noul", noul: 0.77 } }
        : {},
    ),
  );
  await expect(adapter.scoreRelevance(diff, tests)).rejects.toMatchObject({
    code: "invalid-response",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockClear();
  await expect(
    adapter.scoreRelevance(diff, [
      ...tests,
      { file: "huge", source: "界".repeat(10_000), modules: [] },
    ]),
  ).rejects.toThrow("not truncated");
  expect(fetch).not.toHaveBeenCalled();
});

it("caps Clef relevance at 64 questions even if bytes allow more, and stops on cancellation", async () => {
  const tiny = Array.from({ length: 65 }, (_, i) => ({
    file: `${i}`,
    source: "",
    modules: [],
  }));
  const chunks = buildRelevanceRequests("diff", tiny, "clef");
  expect(chunks.flatMap((chunk) => chunk.indexes)).toEqual(
    Array.from({ length: 65 }, (_, i) => i),
  );
  expect(
    chunks.every(
      (chunk) =>
        chunk.indexes.length <= 64 &&
        Buffer.byteLength(JSON.stringify(chunk.request)) <= 56_000,
    ),
  ).toBe(true);
  const controller = new AbortController();
  const fetch = vi.fn(async () => {
    controller.abort();
    return response({ test0: { type: "noul", noul: 0.8 } });
  });
  await expect(
    new ClefAdapter({
      accountId,
      apiKey: "test",
      model: "clef",
      fetch,
    }).scoreRelevance(diff, tests, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
