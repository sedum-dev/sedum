import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileClassificationCache,
  MODEL_CHOICES,
  NoopClassificationCache,
  ProviderError,
  classifySteps,
} from "@sedum-dev/core";
import type { Fetch } from "@typesafe-ai/sdk";
import { TypeSafeAdapter } from "./index.js";
import { buildClassificationRequests } from "./request.js";

const probabilities = Object.fromEntries(
  MODEL_CHOICES.map((op) => [op, op === "remember" ? 0.9 : 0.01]),
);
function reply(keys: readonly string[], answer = "remember") {
  return {
    answers: Object.fromEntries(
      keys.map((key) => [
        key,
        { type: "choice", choice: answer, probabilities },
      ]),
    ),
    model: "jev-1.13.0",
    usage: { input_tokens: 120, output_tokens: 5 },
  };
}
function transport(replies: unknown[]) {
  const bodies: unknown[] = [];
  const fetch: Fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    if (!next) throw new Error("Unexpected call");
    return new Response(JSON.stringify(next), {
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, bodies };
}

describe("classification TypeSafe boundary", () => {
  it("warms a committed answer through the real adapter and replays it offline", async () => {
    const folder = await mkdtemp(join(tmpdir(), "sedum-classification-wire-"));
    try {
      const path = join(folder, ".sedum", "classifications.json");
      const wire = transport([reply(["line0"])]);
      const sentence = "capture the first product name as {{item}}";
      const input = [
        {
          sentence,
          source: { file: "tests/checkout.test.yaml", line: 12, col: 5 },
        },
      ];
      const cold = await classifySteps(input, {
        mode: "allow-model",
        cache: await FileClassificationCache.load(path, "jev-latest"),
        provider: new TypeSafeAdapter({
          apiKey: "test-key",
          fetch: wire.fetch,
        }),
      });
      expect(cold.steps[0]).toMatchObject({
        op: "remember",
        classificationSource: "model",
      });
      expect(cold.diagnostics).toEqual([]);
      expect(cold.metrics).toMatchObject({ requests: 1, inputTokens: 120 });
      const warm = await classifySteps(input, {
        mode: "offline",
        cache: await FileClassificationCache.load(path, "jev-latest"),
      });
      expect(warm.steps[0]).toMatchObject({
        op: "remember",
        classificationSource: "cache",
      });
      expect(warm.metrics.requests).toBe(0);
      expect(wire.bodies).toHaveLength(1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("asks independent Choices in one request, with no page or resolved values", async () => {
    const lines = [
      "remember the price as {{jacket}}",
      "capture the name as {{product}}",
    ];
    const wire = transport([reply(["line0", "line1"])]);
    const adapter = new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: wire.fetch,
    });
    const result = await adapter.classifyBatch(lines);
    expect(wire.bodies).toHaveLength(1);
    const body = wire.bodies[0] as {
      state: unknown;
      questions: Record<string, unknown>;
      model: string;
    };
    expect(body.state).toEqual({});
    expect(Object.keys(body.questions)).toEqual(["line0", "line1"]);
    expect(JSON.stringify(body)).toContain("{{jacket}}");
    expect(JSON.stringify(body)).not.toContain("$49.99");
    expect(result.answers.map((a) => a.op)).toEqual(["remember", "remember"]);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.usage.inputTokens).toBe(120);
  });

  it("chunks deterministically and validates the complete answer-key set", async () => {
    const lines = Array.from(
      { length: 65 },
      (_, i) => `capture item ${i} as {{item}}`,
    );
    const chunks = buildClassificationRequests(lines);
    expect(chunks.map((chunk) => chunk.indexes.length)).toEqual([50, 15]);
    const wire = transport(chunks.map((chunk) => reply(chunk.keys)));
    const result = await new TypeSafeAdapter({
      apiKey: "test-key",
      fetch: wire.fetch,
    }).classifyBatch(lines);
    expect(wire.bodies).toHaveLength(2);
    expect(result.answers).toHaveLength(65);
    expect(result.calls).toHaveLength(2);
    const wrong = transport([reply(["line0", "unexpected"])]);
    await expect(
      new TypeSafeAdapter({
        apiKey: "test-key",
        fetch: wrong.fetch,
      }).classifyBatch(["capture item as {{item}}"]),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("retains billed receipts and failed attempts when a later chunk fails", async () => {
    const sentences = Array.from(
      { length: 65 },
      (_, index) => `capture item ${index} as {{item}}`,
    );
    const first = buildClassificationRequests(sentences)[0]!;
    let requests = 0;
    const fetch: Fetch = async () => {
      requests++;
      if (requests > 1)
        return new Response(JSON.stringify({ error: "upstream unavailable" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify(reply(first.keys)), {
        headers: { "content-type": "application/json" },
      });
    };
    const result = await classifySteps(
      sentences.map((sentence, index) => ({
        sentence,
        source: { file: "tests/long.test.yaml", line: index + 1, col: 5 },
      })),
      {
        mode: "allow-model",
        cache: new NoopClassificationCache(),
        provider: new TypeSafeAdapter({
          apiKey: "test-key",
          fetch,
          backoffInitialMs: 1,
        }),
      },
    );
    expect(result.steps.every((step) => step === null)).toBe(true);
    expect(result.diagnostics).toHaveLength(65);
    expect(result.metrics).toMatchObject({
      requests: 2,
      attempts: 4,
      inputTokens: 120,
      outputTokens: 5,
      costUsd: null,
    });
    expect(result.calls).toHaveLength(1);
    expect(requests).toBe(4);
  });

  it("rejects invalid distributions and overlong input before an action", async () => {
    const bad = reply(["line0"]);
    (
      bad.answers.line0 as { probabilities: Record<string, number> }
    ).probabilities.remember = Number.NaN;
    const wire = transport([bad]);
    await expect(
      new TypeSafeAdapter({
        apiKey: "test-key",
        fetch: wire.fetch,
      }).classifyBatch(["capture the price as {{price}}"]),
    ).rejects.toMatchObject({ code: "invalid-response" });
    const noWire = transport([]);
    await expect(
      new TypeSafeAdapter({
        apiKey: "test-key",
        fetch: noWire.fetch,
      }).classifyBatch(["x".repeat(513)]),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(noWire.bodies).toHaveLength(0);
  });
});
