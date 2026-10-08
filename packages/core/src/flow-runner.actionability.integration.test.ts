import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import {
  MODEL_CHOICES,
  type ModelChoice,
  type ClassificationProvider,
} from "./classification.js";
import { runFlow } from "./flow-runner.js";
import { RunRecorder } from "./run-recorder.js";
import type { ProviderCall, Resolver } from "./provider.js";

const call: ProviderCall = {
  requestedModel: "deterministic",
  model: "deterministic",
  attempts: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

const choose: Resolver["choose"] = async (_sentence, offered) => {
  const target = offered.options.find((option) => option.kind === "candidate");
  if (!target || target.kind !== "candidate") throw new Error("Missing button");
  return {
    selection: { kind: "candidate", id: target.candidate.id },
    probabilities: Object.fromEntries(
      offered.options.map((option) => [
        option.kind === "candidate" ? option.candidate.id : "none",
        option === target ? 0.99 : 0.01,
      ]),
    ),
    confidence: null,
    call,
  };
};

const classifyBatch: ClassificationProvider["classifyBatch"] = async (
  sentences,
) => ({
  answers: sentences.map((sentence) => {
    const op = sentence.startsWith("verify") ? "verify" : "click";
    return {
      op,
      probabilities: Object.fromEntries(
        MODEL_CHOICES.map((choice) => [choice, choice === op ? 1 : 0]),
      ) as Record<ModelChoice, number>,
      model: "deterministic",
      requestedModel: "deterministic",
    };
  }),
  calls: [call],
});

function buttonFixture(state: string): string {
  return `<!doctype html><button onclick="
    window.clicks = (window.clicks || 0) + 1;
    document.querySelector('p').textContent = 'Clicks: ' + window.clicks;
    if ('${state}' === 'covered') {
      document.querySelector('#cover').hidden = false;
      setTimeout(() => document.querySelector('#cover').hidden = true, 1000);
    } else if ('${state}' === 'replaced') {
      this.setAttribute('disabled', 'true');
      setTimeout(() => {
        const replacement = this.cloneNode(true);
        replacement.removeAttribute('disabled');
        this.replaceWith(replacement);
      }, 1000);
    } else {
      this.setAttribute('${state}', 'true');
      setTimeout(() => this.removeAttribute('${state}'), 1000);
    }
  ">Next</button><p>Clicks: 0</p><div id="cover" hidden style="position:fixed;inset:0;background:white"></div>`;
}

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "click actionability",
  () => {
    it.each(["aria-disabled", "disabled", "covered", "replaced"])(
      "waits for a transient %s button without duplicating clicks",
      async (state) => {
        const html = buttonFixture(state);
        const server = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(html);
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing port");
        const root = await mkdtemp(path.join(tmpdir(), "sedum-actionability-"));
        try {
          const file = path.join(root, "click.test.yaml");
          await writeFile(
            file,
            `url: http://127.0.0.1:${address.port}\nsteps:\n  - click the Next button\n  - click the Next button\n  - "verify the text Clicks: 2 is shown"\n`,
          );
          const recorder = new RunRecorder(
            async () => undefined,
            "actionability",
          );
          await recorder.start();
          const result = await runFlow(file, {
            repoRoot: root,
            browser: new PlaywrightBrowserDriver(),
            browserKind: "chromium",
            classificationCache: new NoopClassificationCache(),
            env: {},
            provider: {
              classifyBatch,
              choose,
              holds: async (_claim, digest) => ({
                holds: digest.text.includes("Clicks: 2") ? 1 : 0,
                contradicted: digest.text.includes("Clicks: 2") ? 0 : 1,
                call,
              }),
            },
            report: {
              recorder,
              privacy: { secretValues: [], sensitiveOrigins: [] },
              evidenceEnabled: false,
              replay: false,
              saveFrame: async () => ({
                status: "omitted",
                reason: "disabled",
              }),
            },
          });
          expect(result.status, JSON.stringify(result)).toBe("passed");
          const steps = recorder.snapshot.tests[0]?.attempts[0]?.steps ?? [];
          expect(steps.map((step) => step.verdict)).toEqual([
            "passed",
            "passed",
            "passed",
          ]);
          expect(steps[1]!.elapsedMs).toBeGreaterThan(700);
          expect(steps[1]!.elapsedMs).toBeLessThan(8000);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        }
      },
      30000,
    );
  },
);
