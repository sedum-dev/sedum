import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CHOICES,
  classifySteps,
  evaluateModelAnswer,
  patternOperation,
  preflightSentence,
  validateOperand,
  type ClassificationProvider,
  type ModelChoice,
  type ClassificationInput,
} from "./classification.js";
import {
  FileClassificationCache,
  NoopClassificationCache,
  classificationKey,
} from "./classification-cache.js";
import type { ProviderCall } from "./provider.js";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});
async function cacheFile() {
  const folder = await mkdtemp(join(tmpdir(), "sedum-classification-"));
  folders.push(folder);
  return join(folder, ".sedum", "classifications.json");
}
const source = { file: "tests/login.test.yaml", line: 7, col: 5 };
function step(sentence: string, line = 7): ClassificationInput {
  return { sentence, source: { ...source, line } };
}
function distribution(op: ModelChoice, probability = 0.9) {
  const rest = (1 - probability) / (MODEL_CHOICES.length - 1);
  return Object.fromEntries(
    MODEL_CHOICES.map((choice) => [choice, choice === op ? probability : rest]),
  ) as Record<ModelChoice, number>;
}
const call: ProviderCall = {
  requestedModel: "jev-latest",
  model: "jev-1.13.0",
  attempts: 1,
  usage: { inputTokens: 100, outputTokens: 20 },
  rate: null,
  successfulResponseCostUsd: 0.0000042,
  totalCostUsd: 0.0000042,
};
function fakeProvider(op: ModelChoice): {
  provider: ClassificationProvider;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    provider: {
      async classifyBatch(sentences) {
        calls.push([...sentences]);
        return {
          answers: sentences.map(() => ({
            op,
            probabilities: distribution(op),
            model: call.model,
            requestedModel: call.requestedModel,
          })),
          calls: [call],
        };
      },
    },
  };
}

describe("sentence classification", () => {
  it("classifies the labeled PoC login and checkout corpus offline", async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL(
          "../../../fixtures/classification-corpus.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{ sentence: string; op: string }>;
    const result = await classifySteps(
      corpus.map(({ sentence }, index) => step(sentence, index + 1)),
      {
        mode: "offline",
        cache: new NoopClassificationCache(),
      },
    );
    expect(result.steps.map((item) => item?.op)).toEqual(
      corpus.map(({ op }) => op),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.metrics).toMatchObject({
      pattern: corpus.length,
      requests: 0,
      costUsd: 0,
    });
  });

  it("rejects the labeled near-miss corpus offline", async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL(
          "../../../fixtures/classification-near-misses.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{ sentence: string; code: string }>;
    const result = await classifySteps(
      corpus.map(({ sentence }, index) => step(sentence, index + 1)),
      { mode: "offline", cache: new NoopClassificationCache() },
    );
    expect(result.steps).toEqual(corpus.map(() => null));
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      corpus.map(({ code }) => code),
    );
    expect(result.metrics.requests).toBe(0);
  });

  it("rejects temporal second actions before provider dispatch", async () => {
    const { provider, calls } = fakeProvider("click");
    const sentences = [
      "click Continue once you type {{password}} into the password field",
      "click Continue after the password field is filled with {{password}}",
      "click Save and afterwards press Enter",
      "click Save and later press Enter",
      "click Save and afterwards verify the confirmation page appears",
      "verify the order total and tax are correct after you click Checkout",
      "verify the order total and tax are correct and please click Checkout",
      "click Continue as soon as you type {{password}} into the password field",
    ];
    const result = await classifySteps(
      sentences.map((sentence) => step(sentence)),
      {
        mode: "allow-model",
        cache: new NoopClassificationCache(),
        provider,
      },
    );
    expect(result.steps).toEqual(sentences.map(() => null));
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      sentences.map(() => "multiple_actions"),
    );
    expect(calls).toEqual([]);
  });

  it("keeps temporal page-state claims as single verify steps", async () => {
    const sentences = [
      "verify the order confirmation is shown after checkout",
      "verify the cart is empty when no items have been added",
      "verify the button is disabled when the form is filled",
      "verify the page shows a form and a submit button",
      "verify a Search button and an Open menu are shown",
      "verify the address and opening hours are visible",
      "verify the address and opening times are visible",
      "verify a Search button and Open menu are shown",
    ];
    const result = await classifySteps(
      sentences.map((sentence) => step(sentence)),
      {
        mode: "offline",
        cache: new NoopClassificationCache(),
      },
    );
    expect(result.steps.map((item) => item?.op)).toEqual(
      sentences.map(() => "verify"),
    );
    expect(result.diagnostics).toEqual([]);
  });

  it("classifies the supported PoC verbs including accepted remember, without a model", async () => {
    const examples: Array<[string, string]> = [
      ["type {{user}} in the username field", "type"],
      ['type "{{user}}@example.com" in the email field', "type"],
      ["click the login button", "click"],
      ["press Enter", "press"],
      ["goto https://example.com/login", "goto"],
      ["verify products with prices are shown", "verify"],
      ["note at least one result is rated 5 out of 5 stars", "measure"],
      ["scroll down", "scroll"],
      ["wait for 2 seconds", "wait"],
      ["remember the price shown as {{jacket}}", "remember"],
    ];
    const result = await classifySteps(
      examples.map(([sentence], i) => step(sentence, i + 1)),
      {
        mode: "offline",
        cache: new NoopClassificationCache(),
      },
    );
    expect(result.steps.map((item) => item?.op)).toEqual(
      examples.map(([, op]) => op),
    );
    expect(
      result.steps.every(
        (item) =>
          item?.classificationSource === "pattern" && item.probability === null,
      ),
    ).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.metrics).toMatchObject({
      pattern: examples.length,
      model: 0,
      requests: 0,
      costUsd: 0,
    });
  });

  it("reports unsafe sentences with their exact text and position without dispatch", async () => {
    const input = [
      step("click Save, then press Enter", 9),
      step("drag the card into the cart", 10),
      step("type {{first}} then {{last}}", 11),
      step("activate the submit button", 12),
    ];
    const result = await classifySteps(input, {
      mode: "offline",
      cache: new NoopClassificationCache(),
    });
    expect(result.steps).toEqual([null, null, null, null]);
    expect(
      result.diagnostics.map(({ code, sentence, source }) => [
        code,
        sentence,
        source.file,
        source.line,
        source.col,
      ]),
    ).toEqual([
      ["multiple_actions", input[0]!.sentence, source.file, 9, 5],
      ["unsupported", input[1]!.sentence, source.file, 10, 5],
      ["invalid_operand", input[2]!.sentence, source.file, 11, 5],
      ["unavailable", input[3]!.sentence, source.file, 12, 5],
    ]);
    expect(preflightSentence('click the "Save and type" button')).toBeNull();
    expect(preflightSentence("click the 'Save and type' button")).toBeNull();
    expect(preflightSentence("verify the price and click Buy")).toBe(
      "multiple_actions",
    );
    expect(preflightSentence("click Save; upload a file")).toBe(
      "multiple_actions",
    );
    expect(preflightSentence("click Save then go to the cart")).toBe(
      "multiple_actions",
    );
    expect(preflightSentence("hover over the menu")).toBe("unsupported");
    expect(patternOperation("go to the cart")).toBeNull();
    expect(patternOperation("click Save and close the menu")).toBeNull();
    expect(patternOperation("click Save, open the menu")).toBeNull();
    expect(patternOperation('click the "Save and Continue" button')).toBe(
      "click",
    );
    expect(
      validateOperand("type {{first}} then {{last}}", "type"),
    ).toBeTruthy();
  });

  it("batches unresolved unique sentences, persists only accepted model results, and replays offline", async () => {
    const path = await cacheFile();
    const cache = await FileClassificationCache.load(path, "jev-latest");
    const { provider, calls } = fakeProvider("click");
    const input = [
      step("activate the submit button"),
      step("activate the submit button", 8),
    ];
    const cold = await classifySteps(input, {
      mode: "allow-model",
      cache,
      provider,
    });
    expect(calls).toEqual([[input[0]!.sentence]]);
    expect(cold.steps.map((item) => item?.classificationSource)).toEqual([
      "model",
      "model",
    ]);
    expect(cold.metrics).toMatchObject({
      requests: 1,
      attempts: 1,
      inputTokens: 100,
      costUsd: 0.0000042,
    });
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain("activate the submit button");
    expect(saved).toContain(classificationKey(input[0]!.sentence));
    const warm = await classifySteps(input, {
      mode: "offline",
      cache: await FileClassificationCache.load(path, "jev-latest"),
    });
    expect(warm.steps.map((item) => item?.classificationSource)).toEqual([
      "cache",
      "cache",
    ]);
    expect(warm.metrics).toMatchObject({ requests: 0, cache: 2, costUsd: 0 });
  });

  it("accepts model-only paraphrases with explicit operands", async () => {
    const clicked = await classifySteps([step("open the settings menu")], {
      mode: "allow-model",
      cache: new NoopClassificationCache(),
      provider: fakeProvider("click").provider,
    });
    expect(clicked.steps[0]).toMatchObject({
      op: "click",
      classificationSource: "model",
    });
    expect(clicked.diagnostics).toEqual([]);
    const typed = await classifySteps(
      [step("put {{user}} in the username field")],
      {
        mode: "allow-model",
        cache: new NoopClassificationCache(),
        provider: fakeProvider("type").provider,
      },
    );
    expect(typed.steps[0]).toMatchObject({
      op: "type",
      classificationSource: "model",
    });
    expect(typed.diagnostics).toEqual([]);
    for (const [sentence, op] of [
      ["pause for 2 seconds", "wait"],
      ["send the Enter key", "press"],
      ["move down the page", "scroll"],
      ["visit https://example.com/cart", "goto"],
      ["make sure the cart shows the item", "verify"],
      ["count the products on the page", "measure"],
      ["capture the price as {{price}}", "remember"],
    ] as const) {
      expect(patternOperation(sentence)).toBeNull();
      const result = await classifySteps([step(sentence)], {
        mode: "allow-model",
        cache: new NoopClassificationCache(),
        provider: fakeProvider(op).provider,
      });
      expect(result.steps[0]).toMatchObject({
        op,
        classificationSource: "model",
      });
      expect(result.diagnostics).toEqual([]);
    }
    expect(
      validateOperand("pause for 2 seconds and 3 seconds", "wait"),
    ).toBeTruthy();
    expect(validateOperand("send Enter and Tab", "press")).toBeTruthy();
    expect(validateOperand("move up and down the page", "scroll")).toBeTruthy();
    expect(
      validateOperand('type "in stock" in the status field', "type"),
    ).toBeNull();
    expect(
      validateOperand('click the "{{x}} in field" button', "type"),
    ).toBeTruthy();
  });

  it("rejects non-executable model choices and low-margin answers without caching", async () => {
    const path = await cacheFile();
    const cache = await FileClassificationCache.load(path, "jev-latest");
    const { provider } = fakeProvider("unsupported_or_unclear");
    const result = await classifySteps([step("perform magic")], {
      mode: "allow-model",
      cache,
      provider,
    });
    expect(result.steps).toEqual([null]);
    expect(result.diagnostics[0]?.code).toBe("unsupported");
    await expect(readFile(path, "utf8")).rejects.toThrow();
    const tied = distribution("click", 0.51);
    tied.type = 0.47;
    tied.unsupported_or_unclear = 0.02;
    for (const key of MODEL_CHOICES)
      if (!["click", "type", "unsupported_or_unclear"].includes(key))
        tied[key] = 0;
    expect(
      evaluateModelAnswer({
        op: "click",
        probabilities: tied,
        model: call.model,
        requestedModel: call.requestedModel,
      }),
    ).toEqual({ accepted: false, reason: "ambiguous" });
    const multiple = fakeProvider("multiple_actions");
    const refused = await classifySteps(
      [step("activate Save and also submit")],
      {
        mode: "allow-model",
        cache: new NoopClassificationCache(),
        provider: multiple.provider,
      },
    );
    expect(refused.steps[0]).toBeNull();
    expect(refused.diagnostics[0]?.code).toBe("multiple_actions");
  });

  it("keeps provider failures and unknown cost visible without guessing an operation", async () => {
    const provider: ClassificationProvider = {
      async classifyBatch() {
        throw new Error("upstream secret");
      },
    };
    const result = await classifySteps([step("activate the submit button")], {
      mode: "allow-model",
      cache: new NoopClassificationCache(),
      provider,
    });
    expect(result.steps[0]).toBeNull();
    expect(result.diagnostics[0]).toMatchObject({
      code: "provider_error",
      sentence: "activate the submit button",
    });
    expect(JSON.stringify(result)).not.toContain("upstream secret");
    expect(result.metrics.costUsd).toBeNull();
  });

  it("never calls the provider for a malformed remember binding", async () => {
    const called: string[][] = [];
    const provider: ClassificationProvider = {
      async classifyBatch(sentences) {
        called.push([...sentences]);
        throw new Error("should not call");
      },
    };
    const result = await classifySteps([step("remember the price")], {
      mode: "allow-model",
      cache: new NoopClassificationCache(),
      provider,
    });
    expect(result.diagnostics[0]?.code).toBe("invalid_operand");
    expect(called).toEqual([]);
  });

  it("rejects an incoherent batch atomically, with no cache write or fabricated cost", async () => {
    let writes = 0;
    const cache = {
      get: () => ({ answer: null, reason: "absent" }),
      put: () => {
        writes++;
      },
      save: async () => {},
    };
    const provider: ClassificationProvider = {
      async classifyBatch() {
        return {
          answers: [
            {
              op: "click" as const,
              probabilities: distribution("click"),
              model: call.model,
              requestedModel: call.requestedModel,
            },
            {
              op: "click" as const,
              probabilities: { ...distribution("click"), click: 2 },
              model: call.model,
              requestedModel: call.requestedModel,
            },
          ],
          calls: [call],
        };
      },
    };
    const result = await classifySteps(
      [step("activate Save"), step("activate Cancel", 8)],
      {
        mode: "allow-model",
        cache,
        provider,
      },
    );
    expect(result.steps).toEqual([null, null]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "provider_error",
      "provider_error",
    ]);
    expect(writes).toBe(0);
    expect(result.metrics.costUsd).toBeNull();
  });

  it("invalidates changed acceptance policy and corrupt cache entries", async () => {
    const path = await cacheFile();
    const cache = await FileClassificationCache.load(path, "jev-latest");
    const { provider } = fakeProvider("click");
    await classifySteps([step("activate the submit button")], {
      mode: "allow-model",
      cache,
      provider,
    });
    const file = JSON.parse(await readFile(path, "utf8")) as {
      entries: Record<string, Record<string, unknown>>;
    };
    const key = classificationKey("activate the submit button");
    file.entries[key]!.acceptancePolicyVersion = 0;
    await writeFile(path, JSON.stringify(file));
    const oldPolicy = await classifySteps(
      [step("activate the submit button")],
      {
        mode: "offline",
        cache: await FileClassificationCache.load(path, "jev-latest"),
      },
    );
    expect(oldPolicy.steps[0]).toBeNull();
    expect(oldPolicy.diagnostics[0]?.code).toBe("unavailable");
    await writeFile(path, "not JSON");
    const corrupt = await FileClassificationCache.load(path, "jev-latest");
    expect(corrupt.get("activate the submit button").reason).toBe("corrupt");
  });

  it("merges two concurrent cache saves without losing either sentence", async () => {
    const path = await cacheFile();
    const first = await FileClassificationCache.load(path, "jev-latest");
    const second = await FileClassificationCache.load(path, "jev-latest");
    const answer = {
      op: "click" as const,
      probabilities: distribution("click"),
      model: call.model,
      requestedModel: call.requestedModel,
    };
    first.put("activate Save", answer);
    second.put("activate Cancel", answer);
    await Promise.all([first.save(), second.save()]);
    const merged = await FileClassificationCache.load(path, "jev-latest");
    expect(merged.get("activate Save").answer?.op).toBe("click");
    expect(merged.get("activate Cancel").answer?.op).toBe("click");
  });
});
