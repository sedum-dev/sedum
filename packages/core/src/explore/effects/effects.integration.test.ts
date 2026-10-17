import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startExploreSite,
  type ExploreSite,
} from "../../../../../fixtures/site/explore-site.js";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "../../browser-driver.js";
import type { GoalChoice } from "../../goal-runner.js";
import { explore } from "../explorer.js";
import type { ExplorationAdvisor, ExploreDecisionRequest } from "../types.js";

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
