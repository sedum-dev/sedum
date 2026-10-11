import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startExploreSite,
  type ExploreSite,
} from "../../../../fixtures/site/explore-site.js";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "../browser-driver.js";
import type { Resolver } from "../provider.js";
import { emitTest } from "./emit.js";
import { explore } from "./explorer.js";
import { replay, shrink } from "./replay.js";
import type { ExploreAction } from "./types.js";

const link = (name: string): ExploreAction => ({
  kind: "click",
  target: { role: "link", name, occurrence: 0 },
});
const CRASH: readonly ExploreAction[] = [
  link("Search"),
  {
    kind: "type",
    target: {
      role: "searchbox",
      name: "Search products",
      inputType: "search",
      occurrence: 0,
    },
    value: "café ‮",
    source: { kind: "hostile" },
  },
  { kind: "press", key: "Enter" },
];
const SIGNATURE =
  "pageerror: TypeError: Cannot read properties of null (reading 'length')";

/** A scripted resolver: picks the option named in the sentence's quotes. */
const resolver: Resolver = {
  choose: async (sentence, candidates) => {
    const quoted = /"([^"]+)"/u.exec(sentence)?.[1];
    const ids = candidates.options.map((option) =>
      option.kind === "candidate" ? option.candidate.id : option.id,
    );
    const hit = candidates.options.find(
      (option) =>
        option.kind === "candidate" && option.candidate.name === quoted,
    );
    const id = hit?.kind === "candidate" ? hit.candidate.id : "none";
    return {
      selection: hit ? { kind: "candidate", id } : { kind: "none" },
      probabilities: Object.fromEntries(
        ids.map((key) => [key, key === id ? 1 : 0]),
      ),
      confidence: 1,
      call: {
        requestedModel: "scripted",
        model: "scripted",
        attempts: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        rate: null,
        successfulResponseCostUsd: 0,
        totalCostUsd: 0,
      },
    };
  },
};

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "exploration on the /explore fixture shop",
  () => {
    let site: ExploreSite;
    let browser: BrowserSession;
    const freshPage = async () => {
      const context = await browser.newContext();
      return { page: await context.newPage(), close: () => context.close() };
    };
    beforeAll(async () => {
      site = await startExploreSite();
      browser = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
    });
    afterAll(async () => {
      await browser?.close();
      await site?.close();
    });

    it("repeats a blind walk for a seed and stays on the origin", async () => {
      const walk = async () => {
        const fresh = await freshPage();
        try {
          const result = await explore(fresh.page, {
            startUrl: `${site.baseUrl}/explore/`,
            steps: 25,
            seed: 11,
            mode: "random",
            tuning: { skipDestructive: 2 },
          });
          return result.trace;
        } finally {
          await fresh.close();
        }
      };
      const first = await walk();
      const second = await walk();
      expect(first).toHaveLength(25);
      expect(second.map((e) => e.action)).toEqual(first.map((e) => e.action));
      for (const entry of first)
        if (entry.outcome !== "forced")
          expect(entry.route).toMatch(/^\/explore/u);
    }, 120_000);

    it("replays, shrinks and emits a hostile-input crash", async () => {
      const fresh = await freshPage();
      const replayed = await replay(
        fresh.page,
        `${site.baseUrl}/explore/`,
        CRASH,
      );
      await fresh.close();
      expect(replayed.events.map((e) => e.signature)).toContain(SIGNATURE);

      const padded = [
        link("Help"),
        link("Catalog"),
        ...CRASH,
        { kind: "reload" } as const,
        link("Home"),
      ];
      const shrunk = await shrink({
        startUrl: `${site.baseUrl}/explore/`,
        actions: padded,
        signature: SIGNATURE,
        freshPage,
      });
      expect(shrunk.reproduced).toBe(true);
      expect(shrunk.actions).toEqual(CRASH);

      const emitted = await freshPage();
      try {
        const test = await emitTest(emitted.page, resolver, {
          startUrl: `${site.baseUrl}/explore/`,
          actions: shrunk.actions,
          failure: {
            signature: SIGNATURE,
            kind: "pageerror",
            message: SIGNATURE,
            step: 4,
          },
          originalLength: padded.length,
        });
        expect(test.reproduced).toBe(true);
        expect(test.steps.map((s) => s.roundTrip)).toEqual([
          "matched",
          "matched",
          "n/a",
        ]);
        expect(test.yaml).toContain('- click the "Search" link');
        expect(test.yaml).toContain(
          '- type {{value1}} into the "Search products" field',
        );
      } finally {
        await emitted.close();
      }
    }, 180_000);
  },
);
