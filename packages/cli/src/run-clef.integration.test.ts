import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver, runGoal } from "@sedum-dev/core";
import { ClefAdapter } from "@sedum-dev/provider-clef";
import { startFixtureSite } from "../../../fixtures/site/server.js";
import { executeRunCommand } from "./run-command.js";

function clefResponse(
  body: {
    state: { page: string; recent_actions?: string[] };
    questions: Record<string, { criteria: Record<string, unknown> }>;
  },
  abstain = false,
) {
  const answers: Record<string, unknown> = {};
  if (body.questions.operation) {
    expect(Object.keys(body.questions.click_target!.criteria)).toEqual([
      "c0",
      "__sedum_no_match",
    ]);
    const operation = body.state.recent_actions?.length ? "DONE" : "CLICK";
    if (operation === "DONE") expect(body.state.page).toContain("Saved");
    for (const [key, question] of Object.entries(body.questions)) {
      const choice =
        key === "operation" ? operation : abstain ? "__sedum_no_match" : "c0";
      answers[key] = {
        type: "choice",
        choice,
        confidence: 0.99,
        probabilities: Object.fromEntries(
          Object.keys(question.criteria).map((id) => [
            id,
            id === choice
              ? 0.99
              : 0.01 / (Object.keys(question.criteria).length - 1),
          ]),
        ),
      };
    }
  } else {
    expect(body.state.page).toContain("Saved");
    answers.holds = { type: "noul", noul: 0.99 };
    answers.contradicted = { type: "noul", noul: 0.01 };
  }
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: {
      model: "clef",
      answers,
      usage: { input_tokens: 27, output_tokens: 0 },
    },
  });
}

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "Clef CLI goal integration",
  () => {
    it.each([false, true])(
      "honors singleton abstention through the flow wrapper (abstain=%s)",
      async (abstain) => {
        const root = await mkdtemp(path.join(tmpdir(), "sedum-clef-cli-"));
        const site = await startFixtureSite();
        const previous = process.cwd();
        let plannerCalls = 0;
        const fetch = vi.fn(
          async (url: string | URL | Request, init?: RequestInit) => {
            expect(String(url)).toBe(
              "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef",
            );
            const body = JSON.parse(String(init?.body));
            expect(body).not.toHaveProperty("images");
            if (body.questions.operation) plannerCalls++;
            return clefResponse(body, abstain);
          },
        );
        try {
          await writeFile(
            path.join(root, "sedum.config.yaml"),
            `browser: chromium\ntests:\n  directory: .\nprovider:\n  name: clef\n`,
          );
          await writeFile(
            path.join(root, "goal.test.yaml"),
            `url: ${site.baseUrl}/single-submit\ngoal: Click Submit once\nverify: Saved is visible\n`,
          );
          vi.stubEnv(
            "CLOUDFLARE_ACCOUNT_ID",
            "0123456789abcdef0123456789abcdef",
          );
          vi.stubEnv("CLOUDFLARE_AUTH_TOKEN", "synthetic-clef-token");
          vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
          vi.stubEnv("TYPESAFE_API_KEY", "");
          vi.stubGlobal("fetch", fetch);
          process.chdir(root);
          const output = await executeRunCommand({
            paths: [],
            evidence: false,
            replay: false,
            sensitiveOrigins: [],
            locatorCacheDisabled: true,
            reporters: ["json", "markdown", "junit"],
          });
          expect(output.diagnostic).toBeNull();
          expect(
            output.result.tests[0]?.verdict,
            JSON.stringify(output.result.tests[0]?.attempts),
          ).toBe(abstain ? "failed" : "passed");
          expect(plannerCalls).toBe(abstain ? 1 : 2);
          expect(fetch).toHaveBeenCalledTimes(abstain ? 1 : 3);
          const calls = output.result.tests[0]!.attempts[0]!.steps.flatMap(
            (step) => step.calls,
          );
          expect(calls.length).toBe(abstain ? 1 : 3);
          expect(
            calls.every(
              (call) => call.provider === "clef" && call.model === "clef",
            ),
          ).toBe(true);
          expect(JSON.stringify(output.result)).not.toContain(
            "synthetic-clef-token",
          );
        } finally {
          process.chdir(previous);
          vi.unstubAllGlobals();
          vi.unstubAllEnvs();
          await site.close();
          await rm(root, { recursive: true, force: true });
        }
      },
      30_000,
    );

    it("discards a stale Clef decision and replans before dispatching exactly once", async () => {
      const site = await startFixtureSite();
      const browser = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${site.baseUrl}/single-submit`);
        const plans: { page: string; recent_actions: string[] }[] = [];
        const fetch = vi.fn(async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.questions.operation) {
            plans.push(body.state);
            if (plans.length === 1)
              // Mutate after observation but before the response, without timers.
              await page.evaluate(
                "document.querySelector('#status').textContent = 'Changed'",
              );
          }
          return clefResponse(body);
        });
        const adapter = new ClefAdapter({
          accountId: "0123456789abcdef0123456789abcdef",
          apiKey: "synthetic-clef-token",
          fetch,
        });
        const result = await runGoal(page, adapter, adapter, {
          goal: "Click Submit once",
          verify: ["Saved is visible"],
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "passed",
          actions: 1,
          requests: 4,
        });
        expect(plans.map((state) => state.recent_actions.length)).toEqual([
          0, 0, 1,
        ]);
        expect(plans[0]!.page).toContain("Ready");
        expect(plans[1]!.page).toContain("Changed");
        expect(plans[2]!.page).toContain("Saved");
        expect(await page.evaluate("window.actionCount")).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(result.calls).toHaveLength(4);
        await context.close();
      } finally {
        await browser.close();
        await site.close();
      }
    }, 30_000);
  },
);
