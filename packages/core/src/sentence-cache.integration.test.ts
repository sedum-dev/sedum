import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "./browser-driver.js";
import { liveCandidates } from "./page-bridge.js";
import { matchEntry, stageEntry, type CacheEntry } from "./page-cache.js";
import { resolveTarget } from "./locator.js";
import { executeStep, RuntimeValue } from "./step-executor.js";
import type { CacheStore } from "./cache-store.js";
import type { ResolverCandidates } from "./provider.js";

const key = new Uint8Array(32).fill(23);
const sentence = "click the Add to cart button for Sauce Labs Backpack";
function card(id: string, name: string) {
  return `<div><div><a href="#"><div>${name}</div></a><div>${"Description ".repeat(12)}</div><div>$ 10<button id="${id}" onclick="window.clicked=(window.clicked||0)+1">Add to cart</button></div></div></div>`;
}
const html =
  card("backpack", "Sauce Labs Backpack") + card("onesie", "Sauce Labs Onesie");
function memory(entry?: CacheEntry): CacheStore {
  return {
    key,
    lookup: async () => (entry ? { entry } : { reason: "absent" }),
    put: async (_key, value) => {
      entry = value;
    },
    invalidate: async () => {
      entry = undefined;
    },
    clear: async () => {
      entry = undefined;
    },
  };
}
function resolver() {
  return {
    choose: vi.fn(async (_sentence: string, offered: ResolverCandidates) => {
      const ids = offered.options.map((option) =>
        option.kind === "none" ? "none" : option.candidate.id,
      );
      return {
        selection: { kind: "none" as const },
        probabilities: Object.fromEntries(
          ids.map((id) => [id, id === "none" ? 0.99 : 0.01 / (ids.length - 1)]),
        ),
        confidence: null,
        call: {
          requestedModel: "fixture",
          model: "fixture",
          attempts: 1,
          usage: { inputTokens: 10, outputTokens: 1 },
          rate: null,
          successfulResponseCostUsd: null,
          totalCostUsd: null,
        },
      };
    }),
  };
}

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "sentence cache identity in a live browser",
  () => {
    let server: Server;
    let base: string;
    let session: BrowserSession;
    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<main id="app">${html}</main>`);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture port");
      base = `http://127.0.0.1:${address.port}/`;
      session = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
    });
    afterAll(async () => {
      await session?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    async function fresh() {
      const context = await session.newContext();
      const page = await context.newPage();
      await page.goto(base);
      return { context, page };
    }
    async function record() {
      const { context, page } = await fresh();
      try {
        const candidates = await liveCandidates(page, "click");
        const selected = candidates.candidates.find(
          (c) => c.signals.id === "backpack",
        )!;
        expect(selected.peers[0]).toBe("Sauce Labs Backpack");
        expect(selected.signals.contextComplete).toBe(false);
        return stageEntry(
          key,
          page.url,
          "click",
          sentence,
          selected,
          candidates,
        );
      } finally {
        await context.close();
      }
    }
    it("relocates in a fresh context and clicks exactly once without model confidence", async () => {
      const cache = memory(await record());
      const { context, page } = await fresh();
      try {
        const model = resolver();
        const result = await resolveTarget(page, model, {
          operation: "click",
          sentence,
          cache,
        });
        expect(result.kind).toBe("resolved");
        expect(model.choose).not.toHaveBeenCalled();
        expect(result.diagnostic).toMatchObject({
          confidence: null,
          topOptions: [],
        });
        if (result.kind !== "resolved") throw new Error("Expected hit");
        await executeStep(page, { op: "click", target: result.target });
        expect(await page.evaluate("window.clicked")).toBe(1);
      } finally {
        await context.close();
      }
    });
    it.each([
      ["missing", "document.querySelector('#backpack').remove()"],
      [
        "duplicate context with different ID",
        `document.querySelector('#app').insertAdjacentHTML('beforeend', ${JSON.stringify(card("duplicate", "Sauce Labs Backpack"))})`,
      ],
      ["disabled", "document.querySelector('#backpack').disabled=true"],
      ["renamed", "document.querySelector('#backpack').textContent='Remove'"],
      [
        "context shifted",
        "document.querySelector('#app a div').textContent='Sauce Labs Onesie'",
      ],
    ])("%s falls back without clicking", async (_name, mutation) => {
      const cache = memory(await record());
      const { context, page } = await fresh();
      try {
        await page.evaluate(mutation!);
        const model = resolver();
        const result = await resolveTarget(page, model, {
          operation: "click",
          sentence,
          cache,
        });
        expect(result.cache).toMatchObject({
          outcome: "miss",
          fallbackCalledModel: true,
        });
        expect(model.choose).toHaveBeenCalled();
        expect(result.kind).toBe("unresolved");
        expect(await page.evaluate("window.clicked || 0")).toBe(0);
      } finally {
        await context.close();
      }
    });
    it("rejects stale cached targets before dispatch", async () => {
      const cache = memory(await record());
      const { context, page } = await fresh();
      try {
        const result = await resolveTarget(page, resolver(), {
          operation: "click",
          sentence,
          cache,
        });
        if (result.kind !== "resolved") throw new Error("Expected hit");
        await page.evaluate(
          "document.querySelector('#backpack').textContent='Remove'",
        );
        await expect(
          executeStep(page, { op: "click", target: result.target }),
        ).rejects.toMatchObject({
          code: "stale",
          phase: "pre_dispatch",
          retryable: true,
        });
        expect(await page.evaluate("window.clicked || 0")).toBe(0);
      } finally {
        await context.close();
      }
    });
    it("fills current ordinary and secret runtime values without storing them", async () => {
      for (const type of ["text", "password"]) {
        const { context, page } = await fresh();
        try {
          await page.evaluate(
            `document.querySelector('#app').innerHTML='<label>Account <input id="account" type="${type}"></label>'`,
          );
          const candidates = await liveCandidates(page, "fill");
          const entry = stageEntry(
            key,
            page.url,
            "fill",
            "type {{value}} in the Account field",
            candidates.candidates[0]!,
            candidates,
          );
          for (const value of ["old-value", "new-value-47"]) {
            const model = resolver();
            const result = await resolveTarget(page, model, {
              operation: "fill",
              sentence: "type {{value}} in the Account field",
              cache: memory(entry),
            });
            if (result.kind !== "resolved")
              throw new Error("Expected fill hit");
            await executeStep(page, {
              op: "type",
              target: result.target,
              value: new RuntimeValue(value),
            });
            expect(
              await page.evaluate("document.querySelector('#account').value"),
            ).toBe(value);
            expect(model.choose).not.toHaveBeenCalled();
            expect(JSON.stringify(entry)).not.toContain(value);
          }
          expect(
            matchEntry(
              entry,
              key,
              page.url,
              "fill",
              "type {{value}} in the Account field",
              candidates.candidates,
              true,
            ).hit,
          ).toBe(true);
        } finally {
          await context.close();
        }
      }
    });
  },
);
