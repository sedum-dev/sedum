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
import { ProviderError, type Resolver } from "../provider.js";
import { emitTest } from "./emit.js";
import { explore } from "./explorer.js";
import { Oracles } from "./oracles.js";
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

    it("takes errors from the bug detector's signals, with its allow rules", async () => {
      const fresh = await freshPage();
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/help`);
        const oracles = await Oracles.attach(fresh.page, site.baseUrl, {
          ignoreConsole: ["^known noise"],
          allow: ["console_error:third-party"],
        });
        await fresh.page.evaluate(`(() => {
          console.error("ResizeObserver loop completed with undelivered notifications");
          console.error("known noise from a widget");
          console.error("third-party script failed");
          console.error("Cart total failed");
          Promise.reject(new Error("checkout lost"));
          setTimeout(() => { throw new Error("late crash"); }, 0);
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const events = await oracles.drain();
        expect(events.map((e) => `${e.kind}: ${e.message}`).sort()).toEqual([
          "console: Cart total failed",
          "pageerror: Error: late crash",
          "rejection: Error: checkout lost",
        ]);
        oracles.detach();
      } finally {
        await fresh.close();
      }
    }, 60_000);

    it("reports a dead link, not a 404 page that moves straight on", async () => {
      const fresh = await freshPage();
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/`);
        const oracles = await Oracles.attach(fresh.page, site.baseUrl);
        await fresh.page.goto(`${site.baseUrl}/explore/moved`);
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await oracles.drain()).toEqual([]);
        await fresh.page.goto(`${site.baseUrl}/explore/no-such-page`);
        const events = await oracles.drain();
        expect(events.map((e) => e.signature)).toEqual([
          "broken-link: HTTP # page /explore/:id",
        ]);
        oracles.detach();
      } finally {
        await fresh.close();
      }
    }, 60_000);

    it("shrinks a bug that shows only some of the time", async () => {
      const draw: ExploreAction = {
        kind: "click",
        target: { role: "button", name: "Draw", occurrence: 0 },
      };
      // Every second draw fails, so a single first replay may pass.
      const shrunk = await shrink({
        startUrl: `${site.baseUrl}/explore/lottery`,
        actions: [draw],
        signature: "http: HTTP # GET /explore/api/draw",
        freshPage,
      });
      expect(shrunk.reproduced).toBe(true);
    }, 120_000);

    it("stops a guided walk once Jev keeps failing", async () => {
      const fresh = await freshPage();
      const down = () => Promise.reject(new Error("no available API credits"));
      try {
        const result = await explore(fresh.page, {
          startUrl: `${site.baseUrl}/explore/`,
          steps: 40,
          seed: 1,
          mode: "guided",
          advisor: { assess: down, decide: down, chooseGoalValue: down },
        });
        expect(result.stopReason).toMatch(/^Jev stopped answering/u);
        expect(result.trace.length).toBeLessThanOrEqual(3);
        // A request refused on this side says nothing about Jev.
        const local = () =>
          Promise.reject(new ProviderError("invalid-input", "too large"));
        const kept = await explore(fresh.page, {
          startUrl: `${site.baseUrl}/explore/`,
          steps: 6,
          seed: 1,
          mode: "guided",
          advisor: { assess: local, decide: local, chooseGoalValue: local },
        });
        expect(kept.stopReason).toBeUndefined();
        expect(kept.trace.length).toBe(6);
      } finally {
        await fresh.close();
      }
    }, 120_000);

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
    function macro(page: BrowserPage, skipSettings = false): FormFlow {
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
        skipSettings,
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

    it("completes a three-page wizard with date parts, a UK postcode, a radio and a sub-form", async () => {
      const fresh = await freshPage();
      const before = site.stats.bugs["trip-estimate"] ?? 0;
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/account/trip/new`);
        const done = await drive(macro(fresh.page), fresh.page);
        expect(fresh.page.url).toContain("/explore/account/trip/created");
        expect(site.stats.bugs["trip-estimate"]).toBe(before + 1);
        expect(done).toContain("click Save & Continue");
        expect(done).toContain("click Create trip");
        // Continue is disabled until the "Add an item" sub-form is saved.
        expect(done).toContain("click Add an item");
        expect(done).toContain("click Save item");
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
        expect(done).toContain("click Select an account type");
        expect(done).toContain("type Choose a store");
        expect(
          done.some((d) =>
            /^click Provider = (Northbank|Riverside|Other)$/u.test(d),
          ),
        ).toBe(true);
        // The member code is retried once with the format its error states.
        expect(done.filter((d) => d === "type Member code")).toHaveLength(2);
      } finally {
        await fresh.close();
      }
    }, 120_000);

    it("makes up a password to sign up, never to sign in", async () => {
      const fresh = await freshPage();
      const before = site.stats.writes["register"] ?? 0;
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/register`);
        const signup = await drive(macro(fresh.page), fresh.page);
        expect(fresh.page.url).toContain("/explore/register/done");
        expect(site.stats.writes["register"]).toBe(before + 1);
        expect(signup).toContain("type Password");
        expect(signup).toContain("type Confirm password");
        await fresh.page.goto(`${site.baseUrl}/explore/signin`);
        const signin = await drive(macro(fresh.page), fresh.page);
        expect(signin).not.toContain("type Password");
      } finally {
        await fresh.close();
      }
    }, 120_000);

    it("stops on a page with nothing to click or fill", async () => {
      const fresh = await freshPage();
      try {
        const result = await explore(fresh.page, {
          startUrl: `${site.baseUrl}/explore/blank`,
          steps: 60,
          seed: 2,
          mode: "random",
        });
        expect(result.stopReason).toMatch(/^Nothing to click or fill/u);
        expect(result.trace.length).toBeLessThanOrEqual(16);
      } finally {
        await fresh.close();
      }
    }, 120_000);

    it("completes one form at a time and never submits with Cancel", async () => {
      const fresh = await freshPage();
      const before = site.stats.writes["support"] ?? 0;
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/support`);
        const done = await drive(macro(fresh.page), fresh.page);
        expect(fresh.page.url).toContain("/explore/help/sent");
        expect(site.stats.writes["support"]).toBe(before + 1);
        expect(done).not.toContain("type Search help");
        expect(done).not.toContain("click Cancel");
        expect(done).toContain("click Send message");
      } finally {
        await fresh.close();
      }
    }, 120_000);

    it("leaves a store-wide settings form alone with safety on", async () => {
      const fresh = await freshPage();
      try {
        await fresh.page.goto(`${site.baseUrl}/explore/account/branding`);
        expect(await macro(fresh.page).offers(await observe(fresh.page))).toBe(
          true,
        );
        const flow = macro(fresh.page, true);
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
