import { expect, it, vi } from "vitest";
import { TypeSafeAdapter } from "./index.js";
import { buildRelevanceRequests } from "./relevance.js";

const tests = [
  { file: "cart.test.yaml", source: "steps: [verify cart total]", modules: [] },
  {
    file: "profile.test.yaml",
    source: "steps: [verify profile name]",
    modules: [],
  },
];

it("sends independent Nouls with per-test context and maps answers by key rather than response order", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          usage: { input_tokens: 123, output_tokens: 0 },
          answers: {
            test1: { type: "noul", noul: 0.01 },
            test0: { type: "noul", noul: 0.82 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const provider = new TypeSafeAdapter({ apiKey: "test-key", fetch });
  const result = await provider.scoreRelevance("cart diff", tests);
  expect(result.probabilities).toEqual([0.82, 0.01]);
  expect(result.calls[0]).toMatchObject({
    model: "jev-1.13.0",
    usage: { inputTokens: 123, outputTokens: 0 },
  });
  const request = buildRelevanceRequests("cart diff", tests, "jev-latest")[0]!
    .request;
  expect(request.state).toEqual({ diff: "cart diff" });
  expect(request.questions.test0).toMatchObject({
    type: "noul",
    instructions: { test: tests[0] },
  });
  expect(request.questions.test1).toMatchObject({
    type: "noul",
    instructions: { test: tests[1] },
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([
  {},
  { test0: { type: "noul", noul: 0.9 } },
  { test0: { type: "noul", noul: 0.9 }, extra: { type: "noul", noul: 0.1 } },
  { test0: { type: "noul", noul: 0.9 }, test1: { type: "noul", noul: 1.1 } },
  { test0: { type: "noul", noul: 0.9 }, test1: { type: "noul", noul: "0" } },
  { test0: { type: "noul", noul: 0.9 }, test1: { type: "choice", noul: 0 } },
])(
  "rejects incomplete or malformed answers instead of silently skipping tests",
  async (answers) => {
    const provider = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            usage: { input_tokens: 1, output_tokens: 0 },
            answers,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await expect(provider.scoreRelevance("diff", tests)).rejects.toThrow();
  },
);

it("batches by byte budget without dropping or truncating tests and preflights all chunks", async () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    file: `${index}.test.yaml`,
    source: "x".repeat(9000),
    modules: [],
  }));
  const chunks = buildRelevanceRequests("diff", many, "jev-latest");
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flatMap((chunk) => chunk.indexes)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  for (const chunk of chunks) {
    expect(
      Buffer.byteLength(JSON.stringify(chunk.request)),
    ).toBeLessThanOrEqual(56_000);
    for (const index of chunk.indexes)
      expect(chunk.request.questions[`test${index}`]).toMatchObject({
        instructions: { test: many[index] },
      });
  }
  const fetch = vi.fn();
  const provider = new TypeSafeAdapter({ apiKey: "test-key", fetch });
  await expect(
    provider.scoreRelevance("diff", [
      ...many,
      { file: "huge", source: "界".repeat(10_000), modules: [] },
    ]),
  ).rejects.toThrow("not truncated");
  expect(fetch).not.toHaveBeenCalled();
});

it("scores every diff chunk, takes max rather than last/noisy-OR, and records every call", async () => {
  const diff = Array.from(
    { length: 3 },
    (_, i) =>
      `diff --git a/ui${i}.ts b/ui${i}.ts\n@@ -1 +1 @@\n+${"x".repeat(9000)}\n`,
  ).join("");
  const source = [
    { file: "large.test.ts", source: "x".repeat(15_500), modules: [] },
  ];
  const chunks = buildRelevanceRequests(diff, source, "jev-latest");
  expect(chunks).toHaveLength(3);
  const values = [0.12, 0.77, 0.31];
  const fetch = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual(
        chunks[fetch.mock.calls.length - 1]!.request,
      );
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          usage: { input_tokens: 123, output_tokens: 0 },
          answers: {
            test0: { type: "noul", noul: values[fetch.mock.calls.length - 1] },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const provider = new TypeSafeAdapter({ apiKey: "test-key", fetch });
  const got = await provider.scoreRelevance(diff, source);
  expect(got).toMatchObject({ probabilities: [0.77], chunkCount: 3 });
  expect(got.calls).toHaveLength(3);
  expect(fetch).toHaveBeenCalledTimes(3);
  fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          usage: { input_tokens: 1, output_tokens: 0 },
          answers:
            fetch.mock.calls.length % 2
              ? { test0: { type: "noul", noul: 0.77 } }
              : {},
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  fetch.mockClear();
  await expect(provider.scoreRelevance(diff, source)).rejects.toMatchObject({
    code: "invalid-response",
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
