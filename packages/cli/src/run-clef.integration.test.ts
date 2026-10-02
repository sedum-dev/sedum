import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startFixtureSite } from "../../../fixtures/site/server.js";
import { executeRunCommand } from "./run-command.js";

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
            const answers: Record<string, unknown> = {};
            if (body.questions.operation) {
              plannerCalls++;
              const ids = Object.keys(body.questions.click_target.criteria);
              expect(ids).toEqual(["c0", "__sedum_no_match"]);
              for (const [key, question] of Object.entries(body.questions) as [
                string,
                { criteria: Record<string, unknown> },
              ][]) {
                const choice =
                  key === "operation"
                    ? plannerCalls === 1
                      ? "CLICK"
                      : "DONE"
                    : abstain
                      ? "__sedum_no_match"
                      : "c0";
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
              if (plannerCalls === 2)
                expect(body.state.page).toContain("Saved");
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
          },
        );
        try {
          await writeFile(
            path.join(root, "sedum.config.yaml"),
            `browser: chromium\ntests:\n  directory: .\nprovider:\n  name: clef\n`,
          );
          await writeFile(
            path.join(root, "goal.test.yaml"),
            `url: ${site.baseUrl}/slow?delay=0\ngoal: Click Submit once\nverify: Saved is visible\n`,
          );
          vi.stubEnv(
            "CLOUDFLARE_ACCOUNT_ID",
            "0123456789abcdef0123456789abcdef",
          );
          vi.stubEnv("CLOUDFLARE_AUTH_TOKEN", "synthetic-clef-token");
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
          expect(output.result.tests[0]?.verdict).toBe(
            abstain ? "failed" : "passed",
          );
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
  },
);
