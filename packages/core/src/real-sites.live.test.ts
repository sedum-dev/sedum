import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserContextSession,
  type BrowserPage,
  type BrowserSession,
} from "./browser-driver.js";
import { collectCandidates, quietPage } from "./page-bridge.js";
import { resolveTarget } from "./locator.js";
import { executeStep, RuntimeValue } from "./step-executor.js";
import type { Resolver } from "./provider.js";

// These checks use live pages, so run them explicitly with SEDUM_REAL_SITES=1.
// The resolver selects a known control from Sedum's public candidate projection;
// no provider key or private DOM selector is needed to exercise the browser path.
describe.skipIf(process.env.SEDUM_REAL_SITES !== "1")("real websites", () => {
  let browser: BrowserSession;

  beforeAll(async () => {
    browser = await new PlaywrightBrowserDriver().launch({
      browser: "chrome",
      headless: false,
    });
  });
  afterAll(async () => browser?.close());

  async function visit(url: string): Promise<{
    page: BrowserPage;
    context: BrowserContextSession;
  }> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.goto(url, { timeoutMs: 30_000 });
    await quietPage(page, 400, 8_000);
    return { page, context };
  }

  function resolver(name: RegExp): Resolver {
    return {
      async choose(_sentence, candidates) {
        const selected = candidates.options.find(
          (option) =>
            option.kind === "candidate" && name.test(option.candidate.name),
        );
        const id =
          selected?.kind === "candidate" ? selected.candidate.id : "none";
        const ids = candidates.options.map((option) =>
          option.kind === "none" ? "none" : option.candidate.id,
        );
        return {
          selection:
            id === "none" ? { kind: "none" } : { kind: "candidate", id },
          probabilities: Object.fromEntries(
            ids.map((option) => [option, option === id ? 1 : 0]),
          ),
          confidence: null,
          call: {
            requestedModel: "live-test",
            model: "live-test",
            attempts: 1,
            usage: { inputTokens: 0, outputTokens: 0 },
            rate: null,
            successfulResponseCostUsd: null,
            totalCostUsd: null,
          },
        };
      },
    };
  }

  it("finds and fills Wikipedia's search field", async () => {
    const { page, context } = await visit(
      "https://en.wikipedia.org/wiki/Ada_Lovelace",
    );
    try {
      const result = await resolveTarget(page, resolver(/^Search Wikipedia$/), {
        operation: "fill",
        sentence: "the Wikipedia search field",
      });
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        const step = await executeStep(page, {
          op: "type",
          target: result.target,
          value: new RuntimeValue("Charles Babbage"),
        });
        expect(step.outcome).toBe("acted");
        expect(
          await page.evaluate<string>(
            "document.querySelector('input[aria-label=\"Search Wikipedia\"]')?.value",
          ),
        ).toBe("Charles Babbage");
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it("finds GitHub's repository file finder", async () => {
    const { page, context } = await visit(
      "https://github.com/microsoft/playwright",
    );
    try {
      const result = await resolveTarget(page, resolver(/^Go to file$/), {
        operation: "fill",
        sentence: "the repository Go to file field",
      });
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        const step = await executeStep(page, {
          op: "type",
          target: result.target,
          value: new RuntimeValue("package.json"),
        });
        expect(step.outcome).toBe("acted");
        expect(
          await page.evaluate<string>(
            "document.querySelector('input[aria-label=\"Go to file\"]')?.value",
          ),
        ).toBe("package.json");
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it("exposes Google Flights' trip type selector", async () => {
    const { page, context } = await visit(
      "https://www.google.com/travel/flights",
    );
    try {
      const candidates = await collectCandidates(page, "click");
      expect(candidates.complete).toBe(true);
      expect(
        candidates.candidates.some(
          (candidate) =>
            candidate.role === "combobox" && /round trip/i.test(candidate.name),
        ),
      ).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);
});
