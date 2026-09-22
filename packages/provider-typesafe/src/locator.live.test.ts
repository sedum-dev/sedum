import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  RuntimeValue,
  collectCandidates,
  executeStep,
  quietPage,
  resolveTarget,
  type BrowserContextSession,
  type BrowserPage,
  type BrowserSession,
  type LocatorResult,
} from "@sedum-dev/core";
import { TypeSafeAdapter } from "./index.js";

describe.skipIf(process.env.SEDUM_LOCATOR_LIVE !== "1")(
  "live locator target checks",
  () => {
    let session: BrowserSession;
    let context: BrowserContextSession;
    let model: TypeSafeAdapter;
    beforeAll(async () => {
      model = new TypeSafeAdapter();
      session = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      context = await session.newContext({
        viewport: { width: 1200, height: 800 },
      });
    });
    afterAll(async () => {
      await context?.close();
      await session?.close();
    });

    async function pageAt(url: string): Promise<BrowserPage> {
      const page = await context.newPage();
      await page.goto(url, { timeoutMs: 30_000 });
      return page;
    }
    function evidence(
      site: string,
      sentence: string,
      result: LocatorResult,
      elapsedMs: number,
    ): void {
      const cost = result.calls.reduce<number | null>(
        (sum, call) =>
          sum === null || call.totalCostUsd === null
            ? null
            : sum + call.totalCostUsd,
        0,
      );
      process.stdout.write(
        JSON.stringify({
          site,
          sentence,
          outcome: result.kind === "resolved" ? "resolved" : result.reason,
          selected:
            result.kind === "resolved"
              ? result.target.driverTarget().name
              : null,
          candidates: result.diagnostic.candidateCount,
          calls: result.calls.length,
          model: result.calls.at(-1)?.model ?? null,
          costUsd: cost,
          elapsedMs: Math.round(elapsedMs),
          top: result.diagnostic.topOptions,
          gate: result.diagnostic.gate ?? null,
        }) + "\n",
      );
    }
    async function locate(
      page: BrowserPage,
      site: string,
      operation: "click" | "fill",
      sentence: string,
    ) {
      const started = performance.now();
      const result = await resolveTarget(page, model, {
        operation,
        sentence,
        timeoutMs: 180_000,
      });
      evidence(site, sentence, result, performance.now() - started);
      return result;
    }

    it("finds Saucedemo login and rejects over-limit product text", async () => {
      const page = await pageAt("https://www.saucedemo.com/");
      for (const [sentence, expected, value] of [
        ["username input", "username", "standard_user"],
        ["password input", "password", "secret_sauce"],
      ] as const) {
        const result = await locate(page, "saucedemo", "fill", sentence);
        expect(result.kind).toBe("resolved");
        if (result.kind === "resolved") {
          expect(result.target.driverTarget().name.toLowerCase()).toContain(
            expected,
          );
          await executeStep(page, {
            op: "type",
            target: result.target,
            value: new RuntimeValue(value),
          });
        }
      }
      const login = await locate(page, "saucedemo", "click", "login button");
      expect(login.kind).toBe("resolved");
      if (login.kind === "resolved")
        await executeStep(page, { op: "click", target: login.target });
      expect((await quietPage(page, 500, 10_000)).quiet).toBe(true);
      const product = await locate(
        page,
        "saucedemo",
        "click",
        "add to cart for the Sauce Labs Backpack item",
      );
      expect(product).toMatchObject({
        kind: "unresolved",
        reason: "request_too_large",
      });
      expect(product.calls).toHaveLength(0);
      const clickCandidates = await collectCandidates(page, "click");
      expect(
        clickCandidates.candidates.some(
          (candidate) =>
            Array.from(candidate.name).length > 120 ||
            candidate.peers.some((peer) => Array.from(peer).length > 80),
        ),
      ).toBe(true);
      await page.close();
    }, 300_000);

    it("finds Hacker News first-story comments and More", async () => {
      const page = await pageAt("https://news.ycombinator.com/");
      const comments = await locate(
        page,
        "hacker-news",
        "click",
        "the comments link for the first story in the list",
      );
      expect(comments.kind).toBe("resolved");
      if (comments.kind === "resolved") {
        const ref = comments.target.driverTarget().ref;
        const firstComments = await page.evaluate<boolean>(`(() => {
          const target = document.querySelector('[data-sedum-ref="${ref}"]');
          const comments = Array.from(document.querySelectorAll('.subtext a'))
            .filter((link) => /comment/i.test(link.textContent || ''));
          return comments[0] === target;
        })()`);
        if (!firstComments) {
          const probe = await page.evaluate<unknown>(`(() => {
            const target = document.querySelector('[data-sedum-ref="${ref}"]');
            return { inSubtext: !!target?.closest('.subtext'),
              parentClass: target?.parentElement?.className || '',
              firstNames: Array.from(document.querySelectorAll('.subtext a'))
                .filter((link) => /comment/i.test(link.textContent || ''))
                .slice(0, 3).map((link) => link.textContent?.trim()) };
          })()`);
          process.stdout.write(
            JSON.stringify({ site: "hacker-news", probe }) + "\n",
          );
        }
        expect(firstComments).toBe(true);
      }
      const more = await locate(
        page,
        "hacker-news",
        "click",
        "the More link at the bottom of the story list",
      );
      expect(more.kind).toBe("resolved");
      if (more.kind === "resolved")
        expect(more.target.driverTarget().name.toLowerCase()).toContain("more");
      await page.close();
    }, 240_000);

    it("rejects Wikipedia's over-limit candidate text before a model call", async () => {
      const page = await pageAt("https://en.wikipedia.org/wiki/Ada_Lovelace");
      const quiet = await quietPage(page, 500, 10_000);
      expect(quiet.quiet).toBe(true);
      const result = await locate(
        page,
        "wikipedia",
        "click",
        "the link to the Charles Babbage article in the article body",
      );
      expect(result).toMatchObject({
        kind: "unresolved",
        reason: "request_too_large",
      });
      expect(result.calls).toHaveLength(0);
      expect(result.diagnostic.candidateCount).toBeGreaterThan(128);
      await page.close();
    }, 300_000);
  },
);
