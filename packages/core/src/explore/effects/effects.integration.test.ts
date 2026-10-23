import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startExploreSite,
  type ExploreSite,
} from "../../../../../fixtures/site/explore-site.js";
import {
  PlaywrightBrowserDriver,
  type BrowserContextSession,
  type BrowserSession,
} from "../../browser-driver.js";
import type { GoalChoice } from "../../goal-runner.js";
import { explore } from "../explorer.js";
import { observe, settle } from "../observe.js";
import { SeededRandom } from "../random.js";
import type { ExplorationAdvisor, ExploreDecisionRequest } from "../types.js";
import { fillActions } from "./form-fill.js";

const call = {
  requestedModel: "scripted",
  model: "scripted",
  attempts: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

/** What a careful labeller would answer, from the subject's text alone. */
const EFFECT_RULES: [RegExp, string][] = [
  [/Delete|Revoke|Start over/u, "log_out_or_reset"],
  [/Follow us/u, "external"],
  [/Subscribe|Send message|Create account/u, "submit_form"],
  [/Join the newsletter/u, "open_form"],
  [
    /^link "(Home|Catalog|Search|Account|Help|Terms|Privacy)"/u,
    "navigate_section",
  ],
  [/one of \d+ like it/u, "open_item_detail"],
  [/Next page|Previous page/u, "paginate"],
];
const FIELD_RULES: [RegExp, string][] = [
  [/Full name|Your name|^textbox "Name"/u, "full_name"],
  [/Email/u, "email"],
  [/ZIP/u, "postal_code"],
  [/Search/u, "search_term"],
];

function answer(choice: string): GoalChoice {
  return { choice, probabilities: { [choice]: 1 }, confidence: 1 };
}

function label(id: string, subject: string): string {
  const rules = id.startsWith("eff_") ? EFFECT_RULES : FIELD_RULES;
  if (id.startsWith("gate")) return "complete_fields";
  return rules.find(([pattern]) => pattern.test(subject))?.[1] ?? "other";
}

const scripted: ExplorationAdvisor = {
  assess: () => Promise.reject(new Error("the effects planner never assesses")),
  decide: (request: ExploreDecisionRequest) => {
    const answers = Object.fromEntries(
      Object.keys(request.questions).map((id) => {
        const subject = request.subject[id.replace(/^\w+?_/u, "")] ?? "";
        return [id, answer(label(id, subject))];
      }),
    );
    return Promise.resolve({ answers, call });
  },
};

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "the effects planner on the /explore fixture shop",
  () => {
    let site: ExploreSite;
    let browser: BrowserSession;
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

    it("refills a rejected form until it submits, opens few records, and never resets", async () => {
      const context = await browser.newContext();
      try {
        const result = await explore(await context.newPage(), {
          startUrl: `${site.baseUrl}/explore/`,
          steps: 60,
          seed: 3,
          mode: "guided",
          planner: "effects",
          advisor: scripted,
        });
        expect(result.planner).toBe("effects");
        // The ZIP field rejects the first postcode; the refill tries another shape.
        expect(result.routes).toContain("/explore/newsletter/welcome");
        const clicked = result.trace.flatMap((e) =>
          e.action.kind === "click" ? [e.action.target] : [],
        );
        expect(
          clicked.some((t) => /Delete|Revoke|Start over/u.test(t.name)),
        ).toBe(false);
        // Records are tried on two items per list, not on all of them.
        const items = new Set(
          clicked
            .filter((t) => t.href?.startsWith("/explore/item/"))
            .map((t) => t.href),
        );
        expect(items.size).toBeGreaterThan(0);
        expect(items.size).toBeLessThanOrEqual(8);
        expect(result.effects!.maxDepth).toBeGreaterThanOrEqual(2);
      } finally {
        await context.close();
      }
    }, 240_000);
  },
);

const PAGES = "http://pages.test";

/** Serve small pages on a made-up origin, in one context. */
async function served(
  browser: BrowserSession,
  pages: Record<string, string>,
  /** Fail this request (the path and its how-manyth load) once. */
  failOnce?: { path: string; load: number },
): Promise<{
  page: Awaited<ReturnType<BrowserContextSession["newPage"]>>;
  close: () => Promise<void>;
}> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const loads = new Map<string, number>();
  await page.playwright!().context.route(`${PAGES}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    loads.set(path, (loads.get(path) ?? 0) + 1);
    if (failOnce?.path === path && failOnce.load === loads.get(path))
      return route.abort("failed");
    const body = pages[path];
    return body === undefined
      ? route.fulfill({ status: 404, body: "not found" })
      : route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><body>${body}</body></html>`,
        });
  });
  return { page, close: () => context.close() };
}

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "the effects planner on small served pages",
  () => {
    let browser: BrowserSession;
    beforeAll(async () => {
      browser = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
    });
    afterAll(async () => {
      await browser?.close();
    });

    it("fills only the form of the control it submits", async () => {
      const { page, close } = await served(browser, {
        "/": `<form><label>Email <input name="email" type="email"></label><button type="button">Subscribe</button></form>
          <form><label>Message <textarea name="message"></textarea></label><button type="button">Send</button></form>`,
      });
      try {
        await page.goto(`${PAGES}/`);
        await settle(page);
        const observation = await observe(page);
        const target = observation.clicks.find((c) => c.name === "Subscribe")!;
        const { actions } = await fillActions({
          page,
          observation,
          roleOf: (fill) => (fill.name.includes("Email") ? "email" : "message"),
          listControl: () => false,
          safe: () => true,
          token: "1",
          random: new SeededRandom(1),
          retries: () => 0,
          password: undefined,
          account: () => undefined,
          target,
        });
        expect(
          actions.map((a) => (a.kind === "type" ? a.target.name : a.kind)),
        ).toEqual(["Email"]);
      } finally {
        await close();
      }
    }, 60_000);

    it("keeps a forward control that stays disabled on two steps from closing it everywhere", async () => {
      const step = (next: string) =>
        `<h1>Step</h1><form><label>Name <input name="n"></label><button type="button" disabled>Continue</button></form><a href="${next}">Next part</a>`;
      const { page, close } = await served(browser, {
        "/": `<a href="/a">Begin</a>`,
        "/a": step("/b"),
        "/b": step("/cart"),
        "/cart": `<h1>Cart</h1><button type="button" onclick="location.href='/done'">Continue</button>`,
        "/done": `<h1>Done</h1><p>Thank you</p>`,
      });
      const advisor: ExplorationAdvisor = {
        assess: () => Promise.reject(new Error("never assessed")),
        decide: (request: ExploreDecisionRequest) => {
          const answers = Object.fromEntries(
            Object.keys(request.questions).map((id) => {
              const subject = request.subject[id.replace(/^\w+?_/u, "")] ?? "";
              const choice = id.startsWith("eff_")
                ? /Continue/u.test(subject)
                  ? "proceed"
                  : "navigate_section"
                : id.startsWith("gate")
                  ? "complete_fields"
                  : "full_name";
              return [id, answer(choice)];
            }),
          );
          return Promise.resolve({ answers, call });
        },
      };
      try {
        const result = await explore(page, {
          startUrl: `${PAGES}/`,
          steps: 30,
          seed: 1,
          mode: "guided",
          planner: "effects",
          advisor,
        });
        // The cart's enabled "Continue" is still tried, by the effects planner itself.
        const done = result.trace.find((e) => e.route === "/done");
        expect(done).toBeDefined();
        expect(done!.step).toBeLessThan(result.effects?.walkFrom ?? Infinity);
      } finally {
        await close();
      }
    }, 120_000);

    it("still loads a page whose URL failed to load once", async () => {
      const { page, close } = await served(
        browser,
        {
          "/": `<a href="/a">Alpha</a> <a href="/b">Beta</a>`,
          "/a": `<h1>Alpha</h1><p>A dead end.</p>`,
          "/b": `<h1>Beta</h1>`,
        },
        // The start page loads once at the start; its next load is travel.
        { path: "/", load: 2 },
      );
      const advisor: ExplorationAdvisor = {
        assess: () => Promise.reject(new Error("never assessed")),
        decide: (request: ExploreDecisionRequest) =>
          Promise.resolve({
            answers: Object.fromEntries(
              Object.keys(request.questions).map((id) => [
                id,
                answer("navigate_section"),
              ]),
            ),
            call,
          }),
      };
      try {
        const result = await explore(page, {
          startUrl: `${PAGES}/`,
          steps: 12,
          seed: 1,
          mode: "guided",
          planner: "effects",
          advisor,
        });
        const travel = result.trace.find(
          (e) => e.action.kind === "goto" && e.outcome === "failed",
        );
        expect(travel).toBeDefined();
        const visited = result.trace.filter(
          (e) => e.step < (result.effects?.walkFrom ?? Infinity),
        );
        expect(visited.map((e) => e.route)).toContain("/a");
        expect(visited.map((e) => e.route)).toContain("/b");
      } finally {
        await close();
      }
    }, 120_000);
  },
);
