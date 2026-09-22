import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import console from "node:console";
import {
  FileClassificationCache,
  MODEL_CHOICES,
  classifySteps,
} from "../packages/core/dist/index.js";
import { TypeSafeAdapter } from "../packages/provider-typesafe/dist/index.js";

const live = process.argv.includes("--live");
if (live && !process.env.TYPESAFE_API_KEY)
  throw new Error("Set TYPESAFE_API_KEY for --live.");

const sample = [
  "click the Login button",
  "capture the first product name as {{item}}",
  "verify the order summary lists {{item}}",
].map((sentence, index) => ({
  sentence,
  source: { file: "tests/checkout.test.yaml", line: index + 1, col: 5 },
}));
const distribution = Object.fromEntries(
  MODEL_CHOICES.map((choice) => [choice, choice === "remember" ? 0.9 : 0.01]),
);
const fixtureProvider = {
  async classifyBatch(sentences) {
    return {
      answers: sentences.map(() => ({
        op: "remember",
        probabilities: distribution,
        model: "jev-fixture",
        requestedModel: "jev-latest",
      })),
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

const folder = await mkdtemp(join(tmpdir(), "sedum-classification-cost-"));
try {
  const path = join(folder, ".sedum", "classifications.json");
  const provider = live ? new TypeSafeAdapter() : fixtureProvider;
  const cold = await classifySteps(sample, {
    mode: "allow-model",
    cache: await FileClassificationCache.load(path, "jev-latest"),
    provider,
  });
  const repeated = await classifySteps(sample, {
    mode: "offline",
    cache: await FileClassificationCache.load(path, "jev-latest"),
  });
  if (cold.diagnostics.length || repeated.diagnostics.length)
    throw new Error("Classification did not complete for the sample file.");
  console.log(
    JSON.stringify(
      {
        mode: live ? "live" : "fixture-receipt",
        file: sample[0].source.file,
        steps: sample.length,
        cold: cold.metrics,
        repeated: repeated.metrics,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(folder, { recursive: true, force: true });
}
