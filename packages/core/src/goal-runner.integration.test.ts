import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { startFixtureSite } from "../../../fixtures/site/server.js";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { parseFlow } from "./flow-loader.js";
import { resolveData } from "./flow-values.js";
import { runGoal, goalOperations, type GoalChoice } from "./goal-runner.js";
import type { ProviderCall } from "./provider.js";

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "goal executor on the existing checkout fixture",
  () => {
    it("executes fresh click/fill targets, uses bindings privately and independently verifies completion", async () => {
      const site = await startFixtureSite();
      const browser = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      const call: ProviderCall = {
        model: "scripted-test",
        requestedModel: "scripted-test",
        attempts: 1,
        usage: { inputTokens: 0, outputTokens: 0 },
        rate: null,
        totalCostUsd: 0,
        successfulResponseCostUsd: 0,
      };
      const choose = (choice: string, ids: string[]): GoalChoice => ({
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          ids.map((id) => [id, id === choice ? 1 : 0]),
        ),
      });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(site.baseUrl + "/login");
        const flow = parseFlow(
          await readFile("fixtures/ui-login-checkout.test.yaml", "utf8"),
          "fixtures/ui-login-checkout.test.yaml",
          { repoRoot: process.cwd() },
        ).value!;
        const data = resolveData(
          {
            ...flow.data,
            password: {
              value: "$PASSWORD",
              source: { file: "test", line: 1, col: 1 },
            },
          },
          { PASSWORD: "fixture_password" },
        );
        const steps = [
          ["TYPE", "Username", "username"],
          ["TYPE", "Password", "password"],
          ["CLICK", "Login"],
          ["CLICK", "Add to cart", "Canvas Backpack"],
          ["CLICK", "Cart"],
          ["CLICK", "Checkout"],
          ["TYPE", "First name", "first"],
          ["TYPE", "Last name", "last"],
          ["TYPE", "Postal code", "postal"],
          ["CLICK", "Place order"],
        ];
        let index = 0;
        const result = await runGoal(
          page,
          {
            chooseGoal: async (state) => {
              expect(JSON.stringify(state)).not.toContain("fixture_password");
              const step = steps[index++];
              const op = step?.[0] ?? "DONE";
              const target = step
                ? Object.entries(state.targets[op]!).find(
                    ([, text]) =>
                      text.includes(`"name":"${step[1]}"`) &&
                      (!step[2] ||
                        text.includes(
                          op === "TYPE" ? `{{${step[2]}}}` : step[2],
                        )),
                  )?.[0]
                : undefined;
              if (step) expect(target).toBeDefined();
              return {
                operation: choose(op, Object.keys(goalOperations(state))),
                ...(target
                  ? { target: choose(target, Object.keys(state.targets[op]!)) }
                  : {}),
                call,
              };
            },
          },
          {
            holds: async (_claim, digest, options) => {
              expect(options?.maxAttempts).toBe(1);
              expect(digest.text).toContain("Order placed");
              return { holds: 0.99, contradicted: 0.01, call };
            },
          },
          { goal: "Complete checkout", verify: ["Order placed"], data },
        );
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "passed",
          actions: 10,
          requests: 12,
        });
        expect(
          await page.evaluate(
            `document.querySelector('#confirmation').textContent`,
          ),
        ).toBe("Order placed");
        expect(JSON.stringify(result)).not.toContain("fixture_password");
        await context.close();
      } finally {
        await browser.close();
        await site.close();
      }
    }, 30_000);
  },
);
