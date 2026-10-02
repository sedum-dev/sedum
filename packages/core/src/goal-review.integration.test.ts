import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startFixtureSite,
  type FixtureSite,
} from "../../../fixtures/site/server.js";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
  type BrowserPage,
  type BrowserContextSession,
} from "./browser-driver.js";
import {
  runGoal,
  goalOperations,
  type GoalChoice,
  type GoalPlanner,
} from "./goal-runner.js";
import { runFlow } from "./flow-runner.js";
import { resolveData } from "./flow-values.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { RunRecorder } from "./run-recorder.js";
import type { ProviderCall } from "./provider.js";

const call: ProviderCall = {
  model: "scripted",
  requestedModel: "scripted",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 0 },
  rate: null,
  totalCostUsd: 0,
  successfulResponseCostUsd: 0,
};
const choice = (id: string, ids: string[]): GoalChoice => ({
  choice: id,
  confidence: 1,
  probabilities: Object.fromEntries(
    ids.map((key) => [key, key === id ? 1 : 0]),
  ),
});

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "goal review regressions",
  () => {
    let site: FixtureSite;
    let browser: BrowserSession;
    let context: BrowserContextSession;
    let page: BrowserPage;
    beforeEach(async () => {
      site = await startFixtureSite();
      browser = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      context = await browser.newContext();
      page = await context.newPage();
      await page.goto(site.baseUrl + "/synthetic-profile");
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await browser?.close();
      await site?.close();
    });

    function emailPlanner(): GoalPlanner {
      return {
        chooseGoal: async (state) => {
          const target = Object.entries(state.targets.TYPE ?? {}).find(
            ([, text]) => text.includes('"name":"Account email"'),
          );
          const op = target ? "TYPE" : "DONE";
          return {
            operation: choice(op, Object.keys(goalOperations(state))),
            ...(target
              ? { target: choice(target[0], Object.keys(state.targets.TYPE!)) }
              : {}),
            call,
          };
        },
        chooseGoalValue: vi.fn(async (state) => ({
          value: choice(
            "faker.internet.exampleEmail",
            Object.keys(state.choices),
          ),
          call,
        })),
      };
    }
    const judge = {
      holds: async () => ({ holds: 0.99, contradicted: 0.01, call }),
    };
    const options = {
      goal: "Fill account email",
      verify: ["Account email is filled"],
      dataSeed: 53,
    };

    it.each(["", "$EMPTY"])(
      "keeps empty fields available with empty binding %j",
      async (empty) => {
        const planner = emailPlanner();
        const data = resolveData(
          {
            optional: {
              value: empty,
              source: { file: "test", line: 1, col: 1 },
            },
            first: {
              value: "Provided",
              source: { file: "test", line: 2, col: 1 },
            },
          },
          { EMPTY: "" },
        );
        expect(data.optional!.value.reveal()).toBe("");
        const result = await runGoal(page, planner, judge, {
          ...options,
          data,
        });
        expect(result).toMatchObject({ status: "passed", actions: 1 });
        expect(
          await page.evaluate("document.querySelector('[name=email]').value"),
        ).toMatch(/@example\.(com|net|org)$/);
      },
    );

    it.each(["same field", "changed entity", "ambiguous surface"])(
      "handles DOM replacement: %s",
      async (change) => {
        const planner = emailPlanner();
        const fill = page.fillRef.bind(page);
        const values: string[] = [];
        const outcomes: unknown[] = [];
        vi.spyOn(page, "fillRef").mockImplementation(
          async (target, value, settings) => {
            values.push(value);
            if (values.length === 1) {
              await page.evaluate(`(() => {
          const input = document.querySelector('[name=email]');
          input.replaceWith(input.cloneNode(true));
          ${change === "changed entity" ? "document.querySelector('h1').textContent = 'Create a profile for another customer';" : ""}
          ${change === "ambiguous surface" ? "document.querySelector('form').append(document.querySelector('[name=email]').parentElement.cloneNode(true));" : ""}
        })()`);
            }
            const outcome = await fill(target, value, settings);
            outcomes.push(outcome);
            return outcome;
          },
        );
        const result = await runGoal(page, planner, judge, options);
        expect(outcomes[0]).toMatchObject({ acted: false, reason: "stale" });
        expect(planner.chooseGoalValue).toHaveBeenCalledTimes(1);
        if (change === "same field") {
          expect(result).toMatchObject({ status: "passed", actions: 1 });
          expect(values).toHaveLength(2);
          expect(values[1]).toBe(values[0]);
          expect(
            await page.evaluate("document.querySelector('[name=email]').value"),
          ).toBe(values[0]);
        } else {
          expect(result).toMatchObject({
            reason: "stale_value_target",
            actions: 0,
          });
          expect(values).toHaveLength(1);
          expect(
            await page.evaluate("document.querySelector('[name=email]').value"),
          ).toBe("");
        }
      },
    );

    it.each([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ])(
      "redacts generated echoes in teardown (report=%s, goal passes=%s)",
      async (report, passes) => {
        const root = await mkdtemp(path.join(tmpdir(), "sedum-goal-privacy-"));
        const recorder = new RunRecorder(async () => {}, "privacy");
        await recorder.start();
        let typed = "";
        const fill = page.fillRef.bind(page);
        vi.spyOn(page, "fillRef").mockImplementation(
          async (target, value, settings) => {
            const result = await fill(target, value, settings);
            if (result.acted) {
              typed = value;
              await page.evaluate(`(() => {
            const p = document.createElement('p'); p.textContent = 'Echo: ' + ${JSON.stringify(value)}; document.body.append(p);
            const button = document.createElement('button'); button.textContent = 'Cleanup ' + ${JSON.stringify(value)}; document.body.append(button);
          })()`);
            }
            return result;
          },
        );
        let teardowns = 0;
        let locators = 0;
        const planner = emailPlanner();
        try {
          const file = path.join(root, "privacy.test.yaml");
          await writeFile(
            file,
            `url: ${site.baseUrl}/synthetic-profile\ngoal: Fill account email\nverify: Echo is visible\nafter:\n  - verify Echo is visible\n  - click Cleanup\n`,
          );
          const result = await runFlow(file, {
            repoRoot: root,
            env: {},
            browser: {
              launch: async () => ({
                newContext: async () => ({
                  newPage: async () => page,
                  close: async () => {},
                }),
                close: async () => {},
              }),
            },
            classificationCache: new NoopClassificationCache(),
            provider: {
              classifyBatch: async () => {
                throw new Error("No classifier needed");
              },
              ...planner,
              chooseGoal: async (state, settings) => {
                if (!typed) return planner.chooseGoal(state, settings);
                const op = passes ? "DONE" : "BLOCKED";
                expect(await page.text()).toContain(typed);
                expect(JSON.stringify(state)).not.toContain(typed);
                return {
                  operation: choice(op, Object.keys(goalOperations(state))),
                  call,
                };
              },
              holds: async (_claim, digest) => {
                teardowns++;
                expect(typed).not.toBe("");
                expect(digest.text).toContain("[sensitive]");
                expect(digest.text).not.toContain(typed);
                return { holds: 0.99, contradicted: 0.01, call };
              },
              choose: async (_sentence, candidates) => {
                locators++;
                expect(JSON.stringify(candidates)).not.toContain(typed);
                const target = candidates.options.find(
                  (option) =>
                    option.kind === "candidate" &&
                    option.candidate.name.includes("Cleanup"),
                );
                if (!target || target.kind !== "candidate")
                  throw new Error("Missing cleanup");
                const id = target.candidate.id;
                return {
                  selection: { kind: "candidate", id },
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    candidates.options.map((option) => {
                      const key =
                        option.kind === "candidate"
                          ? option.candidate.id
                          : option.id;
                      return [key, key === id ? 1 : 0];
                    }),
                  ),
                  call,
                };
              },
            },
            ...(report
              ? {
                  report: {
                    recorder,
                    privacy: { secretValues: [], sensitiveOrigins: [] },
                    evidenceEnabled: false,
                    replay: false,
                    saveFrame: async () => ({
                      status: "omitted" as const,
                      reason: "test" as const,
                    }),
                  },
                }
              : {}),
          });
          expect(result.status, JSON.stringify(result)).toBe(
            passes ? "passed" : "failed",
          );
          expect(teardowns).toBe(passes ? 2 : 1);
          expect(locators).toBeGreaterThan(0);
          if (report) {
            await recorder.finish(null);
            expect(JSON.stringify(recorder.snapshot)).not.toContain(typed);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      30_000,
    );
  },
);
