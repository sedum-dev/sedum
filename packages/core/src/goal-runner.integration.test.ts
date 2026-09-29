import { describe, it, expect } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runFlow } from "./flow-runner.js";
import { RunRecorder } from "./run-recorder.js";
import { RunResultSchema } from "./run-result.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { startFixtureSite } from "../../../fixtures/site/server.js";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { parseFlow } from "./flow-loader.js";
import { resolveData } from "./flow-values.js";
import { runGoal, goalOperations, type GoalChoice } from "./goal-runner.js";
import type { ProviderCall } from "./provider.js";

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "goal executor on the existing checkout fixture",
  () => {
    it.each([true, false])(
      "runs YAML goal through the flow runner, hooks and report (verification passes=%s)",
      async (passes) => {
        const site = await startFixtureSite();
        const root = await mkdtemp(path.join(tmpdir(), "sedum-yaml-goal-"));
        const call: ProviderCall = {
          model: "scripted",
          requestedModel: "scripted",
          attempts: 1,
          usage: { inputTokens: 7, outputTokens: 3 },
          rate: null,
          successfulResponseCostUsd: 0,
          totalCostUsd: 0,
        };
        try {
          const file = path.join(root, "goal.test.yaml");
          await writeFile(
            file,
            `url: ${site.baseUrl}/login\ndata:\n  password: $PASSWORD\nbefore: [verify Login is visible]\ngoal: Observe the Sign in page\nverify: Sign in is visible\nafter: [verify Username is visible]\n`,
          );
          const recorder = new RunRecorder(async () => {}, "yaml-goal");
          await recorder.start();
          let plannerCalls = 0;
          let judgeCalls = 0;
          const result = await runFlow(file, {
            repoRoot: root,
            browser: new PlaywrightBrowserDriver(),
            browserKind: "chromium",
            classificationCache: new NoopClassificationCache(),
            env: { PASSWORD: "private-test-password" },
            verifyPolicy: { minP: 0.95, band: 0.01 },
            provider: {
              classifyBatch: async () => {
                throw new Error("Goal must not be classified as a sentence");
              },
              choose: async () => {
                throw new Error("No locator needed");
              },
              chooseGoal: async (state) => {
                plannerCalls++;
                expect(JSON.stringify(state)).not.toContain(
                  "private-test-password",
                );
                return {
                  operation: {
                    choice: "DONE",
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      Object.keys(goalOperations(state)).map((op) => [
                        op,
                        op === "DONE" ? 1 : 0,
                      ]),
                    ),
                  },
                  call,
                };
              },
              holds: async (claim, digest, options) => {
                judgeCalls++;
                expect(digest.text).toContain("Sign in");
                if (claim === "Sign in is visible")
                  expect(options?.maxAttempts).toBe(1);
                const pass = claim !== "Sign in is visible" || passes;
                return {
                  holds: pass ? 0.99 : 0.92,
                  contradicted: 0.01,
                  call,
                };
              },
            },
            report: {
              recorder,
              privacy: { secretValues: [], sensitiveOrigins: [] },
              evidenceEnabled: false,
              replay: false,
              saveFrame: async () => ({ status: "omitted", reason: "test" }),
            },
          });
          expect(result.status, JSON.stringify(result)).toBe(
            passes ? "passed" : "failed",
          );
          if (!passes)
            expect(result).toMatchObject({
              retryable: false,
              source: { line: 6 },
            });
          expect(plannerCalls).toBe(1);
          expect(judgeCalls).toBe(3);
          await recorder.finish(null);
          const report = RunResultSchema.parse(recorder.snapshot);
          const steps = report.tests[0]!.attempts[0]!.steps;
          expect(steps.map((step) => step.operation)).toEqual([
            "verify",
            "goal",
            "verify",
          ]);
          expect(steps[1]).toMatchObject({
            verdict: passes ? "passed" : "failed",
            judgement: {
              holds: passes ? 0.99 : 0.92,
              threshold: 0.95,
              band: 0.01,
            },
          });
          expect(steps[1]!.calls.map((call) => call.purpose)).toEqual([
            "planner",
            "judge",
          ]);
          expect(report.totals.modelCalls).toBe(4);
          expect(JSON.stringify(report)).not.toContain("private-test-password");
        } finally {
          await site.close();
          await rm(root, { recursive: true, force: true });
        }
      },
      30_000,
    );
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
