import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import {
  goalOperations,
  type GoalPlanner,
  type GoalState,
  type GoalValueState,
  type GoalChoice,
} from "./goal-runner.js";
import { runScriptTest } from "./script-runner.js";
import { RunRecorder } from "./run-recorder.js";
import { RunResultSchema } from "./run-result.js";
import { ProviderError } from "./provider.js";
import type { ProviderCall, JudgePageDigest } from "./provider.js";

const call: ProviderCall = {
  model: "fake",
  requestedModel: "fake",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};
const choice = (id: string, ids: string[]): GoalChoice => ({
  choice: id,
  confidence: 1,
  probabilities: Object.fromEntries(
    ids.map((key) => [key, key === id ? 1 : 0]),
  ),
});
const done = async (state: GoalState) => ({
  operation: choice("DONE", Object.keys(goalOperations(state))),
  call,
});

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "TypeScript goal composition",
  () => {
    let root: string;
    let serial = 0;
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "sedum-goal-ts-"));
    });
    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    async function run(
      body: string,
      planner: Partial<GoalPlanner> = { chooseGoal: done },
      reporting = true,
      signal?: AbortSignal,
    ) {
      const file = path.join(root, `${++serial}.test.ts`);
      await writeFile(
        file,
        `import { test, expect, secret } from ${JSON.stringify(new URL("./script-api.ts", import.meta.url).href)};
      test("goal", async ({ ai, page }) => { ${body} });`,
      );
      const recorder = new RunRecorder(async () => {}, `goal-${serial}`);
      await recorder.start();
      const provider = {
        classifyBatch: vi.fn(async (): Promise<never> => {
          throw new Error("Goals must not be classified");
        }),
        choose: vi.fn(async (): Promise<never> => {
          throw new Error("No authored clicks expected");
        }),
        holds: vi.fn(async (claim: string, digest: JudgePageDigest) => {
          expect(claim).toEqual(expect.any(String));
          expect(digest.text).toEqual(expect.any(String));
          return { holds: 0.01, contradicted: 0.99, call };
        }),
        ...planner,
      };
      const outcome = await runScriptTest(file, undefined, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        browserKind: "chromium",
        classificationCache: new NoopClassificationCache(),
        provider,
        env: {},
        verifyGraceMs: 500,
        ...(signal ? { signal } : {}),
        ...(reporting
          ? {
              report: {
                recorder,
                privacy: { secretValues: [], sensitiveOrigins: [] },
                evidenceEnabled: false,
                replay: false,
                saveFrame: async () => ({
                  status: "omitted" as const,
                  reason: "disabled",
                }),
              },
            }
          : {}),
      });
      await recorder.finish(
        outcome.status === "could_not_run"
          ? { code: outcome.code, message: outcome.message }
          : null,
      );
      const result = recorder.snapshot;
      expect(RunResultSchema.safeParse(result).success).toBe(true);
      return {
        outcome,
        result,
        provider,
        steps: result.tests[0]?.attempts[0]?.steps ?? [],
      };
    }

    it("runs two goals around deterministic code with fresh observations and no hidden Judge", async () => {
      const states: GoalState[] = [];
      const chooseGoal = vi.fn(async (state: GoalState) => {
        states.push(state);
        const target = Object.keys(state.targets.CLICK ?? {})[0];
        return target && state.recentActions.length === 0
          ? {
              operation: choice("CLICK", Object.keys(goalOperations(state))),
              target: choice(target, Object.keys(state.targets.CLICK!)),
              call,
            }
          : done(state);
      });
      const { outcome, result, provider, steps } = await run(
        `
      await page.setContent('<main><button onclick="this.textContent=&quot;Saved&quot;">Save</button></main>');
      await ai.group('Profile', async () => { await ai.goal('Save profile'); });
      await expect(page.getByRole('button')).toHaveText('Saved');
      await page.setContent('<main><h1>Second page</h1></main>');
      await ai.goal('Inspect second page');
    `,
        { chooseGoal },
      );
      expect(outcome.status).toBe("passed");
      expect(provider.holds).not.toHaveBeenCalled();
      expect(provider.classifyBatch).not.toHaveBeenCalled();
      expect(states.map((s) => s.recentActions.length)).toEqual([0, 1, 0]);
      expect(states[2]!.page).toContain("Second page");
      expect(steps.map((s) => s.operation)).toEqual(["click", "goal", "goal"]);
      expect(steps[0]!.group).toEqual(["Profile"]);
      expect(steps[1]).toMatchObject({
        kind: "action",
        judgement: null,
        goal: {
          completion: "planner",
          actions: 1,
          requests: 2,
          reason: "completed",
        },
      });
      expect(result.totals.modelCalls).toBe(3);
    });

    it("does not confuse planner DONE on the wrong page with independent verification", async () => {
      const { outcome, steps, provider } = await run(`
      await page.setContent('<main>Wrong page</main>');
      await ai.goal('Save the profile');
      await ai('verify the profile was successfully saved');
    `);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        status: "failed",
        retryable: false,
      });
      expect(steps[0]).toMatchObject({
        operation: "goal",
        verdict: "passed",
        judgement: null,
      });
      expect(steps[1]).toMatchObject({
        operation: "verify",
        verdict: "failed",
      });
      expect(provider.holds).toHaveBeenCalled();
    });

    it.each([true, false])(
      "prevents retry after a later code failure, reporting=%s",
      async (reporting) => {
        const { outcome } = await run(
          `await ai.goal('Inspect page'); expect(1).toBe(2);`,
          { chooseGoal: done },
          reporting,
        );
        expect(outcome).toMatchObject({ status: "failed", retryable: false });
      },
    );

    it("keeps goal failure sticky when caught and records BLOCKED", async () => {
      const { outcome, steps } = await run(
        `try { await ai.goal('Inspect page'); } catch {} `,
        {
          chooseGoal: async (state) => ({
            operation: choice("BLOCKED", Object.keys(goalOperations(state))),
            call,
          }),
        },
      );
      expect(outcome).toMatchObject({ status: "failed", retryable: false });
      expect(steps[0]!.goal?.reason).toBe("blocked");
    });

    it.each([
      `await ai.goal('');`,
      `await ai.goal(42);`,
      `await ai.goal('Use {{missing}}');`,
      `await ai.goal('Use {{broken');`,
      `await ai.goal('Inspect', { value: {} });`,
      `await ai.goal('Inspect', []);`,
      `await ai.goal('Inspect', undefined, null);`,
      `await ai.goal('Inspect', undefined, []);`,
      `await ai.goal('Inspect', undefined, false);`,
      `await ai.goal('Inspect', undefined, { generateData: 'false' });`,
      `await ai.goal('Inspect', undefined, { generateDate: false });`,
    ])("validates before planner: %s", async (body) => {
      const chooseGoal = vi.fn(done);
      const { outcome } = await run(body, { chooseGoal });
      expect(outcome).toMatchObject({
        status: "could_not_run",
        code: "invalid_test",
        source: { line: 2 },
      });
      expect(chooseGoal).not.toHaveBeenCalled();
    });

    it("rejects unsupported providers without goal actions", async () => {
      const { outcome, steps } = await run(`await ai.goal('Inspect');`, {});
      expect(outcome).toMatchObject({
        status: "could_not_run",
        code: "unsupported",
      });
      expect(steps).toHaveLength(0);
    });

    it("preserves provider authentication errors and records failed calls", async () => {
      const { outcome, result } = await run(`await ai.goal('Inspect');`, {
        chooseGoal: async () => {
          throw new ProviderError("authentication", "Rejected key", 1, call);
        },
      });
      expect(outcome).toMatchObject({
        status: "could_not_run",
        code: "provider_authentication",
      });
      expect(result.totals.modelCalls).toBe(1);
    });

    it("cancellation after planner DONE cannot pass the test", async () => {
      const controller = new AbortController();
      const { outcome } = await run(
        `await ai.goal('Inspect');`,
        {
          chooseGoal: async (state) => {
            controller.abort();
            return done(state);
          },
        },
        true,
        controller.signal,
      );
      expect(outcome).toMatchObject({
        status: "could_not_run",
        code: "canceled",
      });
    });

    it.each([
      `ai.goal('Inspect');`,
      `await Promise.all([ai.goal('One'), ai.goal('Two')]);`,
    ])("rejects missing await or overlap", async (body) => {
      const { outcome } = await run(body);
      expect(outcome).toMatchObject({
        status: "could_not_run",
        code: "invalid_test",
      });
    });

    it("does not persist explicitly supplied bindings into the next goal", async () => {
      const chooseGoal = vi.fn(done);
      const { outcome } = await run(
        `await ai.goal('Inspect {{name}}', { name: 'Ada' }); await ai.goal('Inspect {{name}}');`,
        { chooseGoal },
      );
      expect(outcome).toMatchObject({
        status: "could_not_run",
        code: "invalid_test",
      });
      expect(chooseGoal).toHaveBeenCalledTimes(1);
    });

    it.each([
      { generateData: false, supplied: true },
      { generateData: false, supplied: false },
      { generateData: true, supplied: false },
    ])(
      "controls generation independently of supplied values: %j",
      async ({ generateData, supplied }) => {
        const chooseGoalValue = vi.fn(async (state: GoalValueState) => ({
          value: choice(
            "faker.internet.exampleEmail",
            Object.keys(state.choices),
          ),
          call,
        }));
        const { outcome, steps } = await run(
          `await page.setContent('<main><label>Email<input type="email"></label></main>');
         await ai.goal('Fill email', ${supplied ? "{ email: secret('fixed@example.org') }" : "undefined"}, { generateData: ${generateData} });
         ${supplied ? "await expect(page.getByLabel('Email')).toHaveValue('fixed@example.org');" : ""}`,
          {
            chooseGoal: async (state) => {
              if (state.recentActions.length) return done(state);
              const targets = state.targets.TYPE ?? {};
              const id = Object.keys(targets)[0];
              return {
                operation: choice(
                  id ? "TYPE" : "BLOCKED",
                  Object.keys(goalOperations(state)),
                ),
                ...(id ? { target: choice(id, Object.keys(targets)) } : {}),
                call,
              };
            },
            chooseGoalValue,
          },
        );
        expect(outcome.status).toBe(
          supplied || generateData ? "passed" : "failed",
        );
        expect(chooseGoalValue).toHaveBeenCalledTimes(generateData ? 1 : 0);
        if (!generateData)
          expect(
            steps.find((step) => step.goal)?.goal?.dataSeed,
          ).toBeUndefined();
        if (!supplied && !generateData)
          expect(steps.map((step) => step.operation)).toEqual(["goal"]);
      },
    );

    it.each([true, false])(
      "redacts generated and supplied secrets across goals and verifies, reporting=%s",
      async (reporting) => {
        const states: GoalState[] = [];
        const values: unknown[] = [];
        const planner: GoalPlanner = {
          chooseGoal: async (state) => {
            states.push(state);
            const id = Object.keys(state.targets.TYPE ?? {})[0];
            return id && state.goal.startsWith("Fill")
              ? {
                  operation: choice("TYPE", Object.keys(goalOperations(state))),
                  target: choice(id, Object.keys(state.targets.TYPE!)),
                  call,
                }
              : done(state);
          },
          chooseGoalValue: async (state) => {
            values.push(state);
            return {
              value: choice(
                "faker.internet.exampleEmail",
                Object.keys(state.choices),
              ),
              call,
            };
          },
        };
        const { outcome, provider, result, steps } = await run(
          `
      await page.setContent('<main><label>Email<input type="email"></label></main>');
      await ai.goal('Fill email', { password: secret('supplied-private-sentinel') });
      const email = await page.getByLabel('Email').inputValue();
      expect(email).toMatch(/@example\\.(com|net|org)$/);
      await page.setContent('<main>' + email + ' supplied-private-sentinel</main>');
      await ai.goal('Inspect confirmation');
      await ai('verify the account was created');
    `,
          planner,
          reporting,
        );
        expect(outcome).toMatchObject({ status: "failed", retryable: false });
        expect(values).toHaveLength(1);
        expect(states.at(-1)!.declaredDataKeys).toEqual([]);
        for (const text of [
          JSON.stringify(states),
          JSON.stringify(values),
          JSON.stringify(provider.holds.mock.calls),
          JSON.stringify(result),
        ]) {
          expect(text).not.toContain("supplied-private-sentinel");
          expect(text).not.toMatch(/[\w.+-]+@example\.(com|net|org)/);
        }
        if (reporting) {
          expect(steps.find((s) => s.goal)?.goal?.dataSeed).toEqual(
            expect.any(Number),
          );
          expect(result.totals.modelCalls).toBe(5); // value, TYPE, DONE, next DONE, verify
        }
      },
    );
  },
);
