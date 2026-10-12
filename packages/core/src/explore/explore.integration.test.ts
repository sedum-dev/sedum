import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startExploreSite,
  type ExploreSite,
} from "../../../../fixtures/site/explore-site.js";
import {
  PlaywrightBrowserDriver,
  type BrowserPage,
  type BrowserSession,
} from "../browser-driver.js";
import type { Resolver } from "../provider.js";
import { emitTest } from "./emit.js";
import { explore } from "./explorer.js";
import { replay, shrink } from "./replay.js";
import type { ExploreAction } from "./types.js";
import { runAction } from "./actions.js";
import { FormFlow } from "./form-flow.js";
import { RULE_JUDGE } from "./form-judge.js";
import { formatById, formatTools } from "./forms.js";
import { heuristicGenerator } from "./inputs.js";
import { observe } from "./observe.js";
import { SeededRandom } from "./random.js";
import { goalGenerators } from "../goal-data.js";

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

    /** The form macro with rules only: random options, no model. */
    function macro(page: BrowserPage): FormFlow {
      const random = new SeededRandom(5);
      const tools = formatTools(random);
      const generators = goalGenerators(1);
      return new FormFlow({
        page,
        tools,
        chooseGenerator: async (target) =>
          heuristicGenerator(target.inputType ?? "text", target.name),
        generate: (generator, field) =>
          formatById(generator, tools, field) ?? generators.generate(generator),
        safe: () => true,
        judge: RULE_JUDGE,
      });
    }

    /** Run the macro's plans until it finishes; the actions it took. */
    async function drive(flow: FormFlow, page: BrowserPage): Promise<string[]> {
      const done: string[] = [];
      let plan = await flow.start(await observe(page));
      for (let round = 0; plan && round < 16; round++) {
        for (const action of plan) {
          await runAction(page, action).catch(() => undefined);
          done.push(
            "target" in action
              ? `${action.kind} ${action.target.name}${action.kind === "click" && action.option ? ` = ${action.option}` : ""}`
              : `${action.kind}`,
          );
        }
        plan = await flow.next(await observe(page));
      }
      return done;
    }

    it("completes a two-page wizard with date parts, a UK postcode and a radio", async () => {
      const fresh = await freshPage();
      const before = site.stats.bugs["plan-projection"] ?? 0;
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/account/plan/new`);
        const done = await drive(macro(fresh.page), fresh.page);
        expect(fresh.page.url).toContain("/explore/account/plan/created");
        expect(site.stats.bugs["plan-projection"]).toBe(before + 1);
        expect(done).toContain("click Save & Continue");
        expect(done).toContain("click Create plan");
        expect(done).toContain("click Yes");
      } finally {
        await fresh.close();
      }
    }, 120_000);

    it("completes a dialog with custom and native dropdowns and a summary of errors", async () => {
      const fresh = await freshPage();
      const before = site.stats.writes["accounts"] ?? 0;
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/account/accounts`);
        await runAction(fresh.page, {
          kind: "click",
          target: { role: "button", name: "Add account", occurrence: 0 },
        });
        const done = await drive(macro(fresh.page), fresh.page);
        expect(fresh.page.url).toContain("/explore/account/accounts/saved");
        expect(site.stats.writes["accounts"]).toBe(before + 1);
        expect(done).toContain("click Select a wrapper type");
        expect(
          done.some((d) =>
            /^click Platform = (Aviva|Transact|Other)$/u.test(d),
          ),
        ).toBe(true);
        // The adviser code is retried once with the format its error states.
        expect(done.filter((d) => d === "type Adviser code")).toHaveLength(2);
      } finally {
        await fresh.close();
      }
    }, 120_000);

    it("leaves a firm-wide settings form alone", async () => {
      const fresh = await freshPage();
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/account/branding`);
        const flow = macro(fresh.page);
        const observation = await observe(fresh.page);
        expect(await flow.offers(observation)).toBe(false);
        expect(await flow.start(observation)).toBeNull();
      } finally {
        await fresh.close();
      }
    }, 60_000);

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
