import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "./browser-driver.js";
import type { Judge, ProviderCall } from "./provider.js";
import { measure, verify } from "./assertion-engine.js";

const call: ProviderCall = {
  requestedModel: "jev-latest",
  model: "recorded-jev",
  attempts: 1,
  usage: { inputTokens: 12, outputTokens: 2 },
  rate: null,
  successfulResponseCostUsd: null,
  totalCostUsd: null,
};

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "assertion engine with the built page script",
  () => {
    let server: Server;
    let base: string;
    let session: BrowserSession;

    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><html><body><main id='app'></main></body></html>",
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture port");
      base = `http://127.0.0.1:${address.port}`;
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

    it("waits for delayed visible content, then judges exactly what the page script extracted", async () => {
      const { context, page } = await fresh();
      try {
        await page.evaluate(
          "setTimeout(() => document.querySelector('#app').innerHTML = '<p>Six products are available</p><input value=\"private-input-123\">', 120)",
        );
        const holds = vi.fn(
          async (_claim: string, digest: { text: string }) => {
            expect(digest.text).toContain("Six products are available");
            expect(digest.text).not.toContain("private-input-123");
            return { holds: 0.9, contradicted: 0.1, call };
          },
        );
        const judge = { holds } as unknown as Judge;
        const result = await verify(page, judge, "Six products are available", {
          observationTimeoutMs: 2_000,
        });
        expect(result.verdict).toBe("passed");
        expect(holds).toHaveBeenCalledOnce();
      } finally {
        await context.close();
      }
    });

    it("keeps the wrong-claim evidence and a non-gating measure", async () => {
      const { context, page } = await fresh();
      try {
        await page.evaluate(
          "document.querySelector('#app').innerHTML = '<p>Six products are available</p>'",
        );
        const judge = {
          holds: vi.fn(async () => ({ holds: 0.2, contradicted: 0.9, call })),
        } as unknown as Judge;
        const failed = await verify(
          page,
          judge,
          "The page shows seven products",
        );
        expect(failed.verdict).toBe("failed");
        expect(failed.judgedExcerpt).toContain("Six products are available");
        const observed = await measure(
          page,
          judge,
          "How many products are shown?",
        );
        expect(observed.holds).toBe(0.2);
        expect(observed).not.toHaveProperty("verdict");
      } finally {
        await context.close();
      }
    });

    it("fails a Wikipedia-sized page before calling Judge", async () => {
      const { context, page } = await fresh();
      try {
        await page.evaluate(
          "document.querySelector('#app').innerHTML = '<p>' + 'Ada Lovelace '.repeat(6000) + '</p>'",
        );
        const holds = vi.fn(async () => ({
          holds: 0.9,
          contradicted: 0.1,
          call,
        }));
        await expect(
          verify(page, { holds } as unknown as Judge, "Ada wrote an algorithm"),
        ).rejects.toMatchObject({ code: "oversize_digest" });
        expect(holds).not.toHaveBeenCalled();
      } finally {
        await context.close();
      }
    });
  },
);
