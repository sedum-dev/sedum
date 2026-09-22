import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileClassificationCache,
  NoopClassificationCache,
} from "./classification-cache.js";
import {
  MODEL_CHOICES,
  type ClassificationProvider,
} from "./classification.js";
import { classifyParsedFlow } from "./flow-classification.js";
import { parseFlow } from "./flow-loader.js";
import { isFullyValidated } from "./flow-types.js";

const file = "/project/tests/checkout.test.yaml";
const options = { repoRoot: "/project" };
const probabilities = Object.fromEntries(
  MODEL_CHOICES.map((choice) => [choice, choice === "remember" ? 0.9 : 0.01]),
) as Record<(typeof MODEL_CHOICES)[number], number>;

describe("YAML to operation integration", () => {
  it("collects two positioned classification errors offline without provider or cache writes", async () => {
    const parsed = parseFlow(
      "steps:\n  - click Save then press Enter\n  - activate the submit button\n",
      file,
      options,
    );
    expect(parsed.value).toBeDefined();
    let called = false;
    const provider: ClassificationProvider = {
      async classifyBatch() {
        called = true;
        throw new Error("offline called provider");
      },
    };
    const result = await classifyParsedFlow(parsed, {
      mode: "offline",
      cache: new NoopClassificationCache(),
      provider,
    });
    expect(result.value).toBeUndefined();
    expect(
      result.diagnostics.map((item) => [
        item.code,
        item.source.line,
        item.source.col,
      ]),
    ).toEqual([
      ["multiple_actions", 2, 5],
      ["unavailable", 3, 5],
    ]);
    expect(result.diagnostics.map((item) => item.message)).toEqual([
      expect.stringContaining("click Save then press Enter"),
      expect.stringContaining("activate the submit button"),
    ]);
    expect(result.coverage.steps).toBe("incomplete");
    expect(result.metrics?.requests).toBe(0);
    expect(called).toBe(false);
  });

  it("classifies a real YAML file online and replays it offline from the project cache", async () => {
    const folder = await mkdtemp(join(tmpdir(), "sedum-yaml-classification-"));
    try {
      const cachePath = join(folder, ".sedum", "classifications.json");
      const parsed = parseFlow(
        "steps:\n  - click the Login button\n  - capture the first product name as {{item}}\n  - verify the cart lists {{item}}\n",
        file,
        options,
      );
      expect(parsed.value).toBeDefined();
      let requests = 0;
      const provider: ClassificationProvider = {
        async classifyBatch(sentences) {
          requests++;
          expect(sentences).toEqual([
            "capture the first product name as {{item}}",
          ]);
          return {
            answers: [
              {
                op: "remember",
                probabilities,
                model: "jev-fixture",
                requestedModel: "jev-latest",
              },
            ],
            calls: [
              {
                requestedModel: "jev-latest",
                model: "jev-fixture",
                attempts: 1,
                usage: { inputTokens: 120, outputTokens: 5 },
                rate: null,
                successfulResponseCostUsd: 0.00000504,
                totalCostUsd: 0.00000504,
              },
            ],
          };
        },
      };
      const cold = await classifyParsedFlow(parsed, {
        mode: "allow-model",
        cache: await FileClassificationCache.load(cachePath, "jev-latest"),
        provider,
      });
      expect(cold.diagnostics).toEqual([]);
      expect(
        cold.value?.steps.map((step) =>
          step.kind === "sentence" ? step.op : "module",
        ),
      ).toEqual(["click", "remember", "verify"]);
      expect(cold.coverage).toEqual({
        format: "passed",
        steps: "checked",
        modules: "not_needed",
      });
      expect(isFullyValidated(cold.coverage, cold.diagnostics)).toBe(true);
      expect(requests).toBe(1);
      expect(await readFile(cachePath, "utf8")).not.toContain(
        "first product name",
      );
      const warm = await classifyParsedFlow(parsed, {
        mode: "offline",
        cache: await FileClassificationCache.load(cachePath, "jev-latest"),
      });
      expect(warm.value?.steps[1]).toMatchObject({
        kind: "sentence",
        op: "remember",
        classificationSource: "cache",
        source: { file, line: 3, col: 5 },
      });
      expect(warm.metrics).toMatchObject({
        pattern: 2,
        cache: 1,
        requests: 0,
        costUsd: 0,
      });
      expect(isFullyValidated(warm.coverage, warm.diagnostics)).toBe(true);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("rejects a type step with two values before declaring a file valid", async () => {
    const parsed = parseFlow(
      "data: {first: Ana, last: Ruiz}\nsteps:\n  - type {{first}} {{last}} in the name field\n",
      file,
      options,
    );
    const result = await classifyParsedFlow(parsed, {
      mode: "offline",
      cache: new NoopClassificationCache(),
    });
    expect(result.value).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "invalid_operand",
    );
    expect(result.coverage.steps).toBe("incomplete");
  });
});
