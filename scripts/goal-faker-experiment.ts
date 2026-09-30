/** Bounded live POC: pnpm build && node scripts/goal-faker-experiment.ts (Node 22.18+). */
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { startFixtureSite } from "../fixtures/site/server.ts";
import {
  PlaywrightBrowserDriver,
  runGoal,
} from "../packages/core/dist/index.js";
import { TypeSafeAdapter } from "../packages/provider-typesafe/dist/index.js";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required");
const output = path.resolve(
  ".amp/in/artifacts/goal-faker",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const demo = process.argv.includes("--demo");
const site = await startFixtureSite();
const browser = await new PlaywrightBrowserDriver().launch({
  browser: "chromium",
  ...(demo ? { slowMoMs: 150 } : {}),
});
const adapter = new TypeSafeAdapter({ model: "jev-latest" });
try {
  for (const scenario of ["profile", "missing-credentials"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ...(demo
        ? { recordVideo: { dir: output, size: { width: 1280, height: 720 } } }
        : {}),
    });
    const page = await context.newPage();
    const video = page.playwright()!.page.video();
    const decisions: unknown[] = [];
    try {
      const native = page.playwright()!;
      const cdp = await native.context.newCDPSession(native.page);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 720,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await page.goto(
        site.baseUrl +
          (scenario === "profile" ? "/synthetic-profile" : "/login"),
      );
      const result = await runGoal(
        page,
        {
          chooseGoal: async (state, options) => {
            if (demo) await delay(800);
            return adapter.chooseGoal(state, options);
          },
          chooseGoalValue: async (state, options) => {
            const answer = await adapter.chooseGoalValue(state, options);
            decisions.push({
              field: state.field,
              choice: answer.value.choice,
              confidence: answer.value.confidence,
              top: Object.entries(answer.value.probabilities)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3),
            });
            return answer;
          },
        },
        adapter,
        {
          goal:
            scenario === "profile"
              ? "Create a new test profile with any first name, an account email and a sample biography. Confirm the account email. Continue and add a different recipient with their own email, using the original account email for the receipt. Save the profile."
              : "Sign in to the existing account. No username or password has been supplied. Do not create an account.",
          verify: [
            scenario === "profile"
              ? "Profile saved is visible"
              : "Products is visible",
          ],
          dataSeed: 53,
          onAction: async (action) => {
            console.log(scenario, action.sentence, action.status);
            if (demo) await delay(700);
            if (scenario === "profile" && action.operation === "type") {
              const name = page.url.endsWith("/synthetic-profile")
                ? "profile"
                : "recipient";
              await page
                .playwright()!
                .page.screenshot({ path: path.join(output, `${name}.png`) });
            }
          },
        },
      );
      const checks =
        scenario === "profile"
          ? await page.evaluate(`(() => {
        const p = JSON.parse(sessionStorage.getItem('profile') || 'null');
        const r = JSON.parse(sessionStorage.getItem('recipient') || 'null');
        return { saved: document.querySelector('#message')?.textContent === 'Profile saved',
          firstName: !!p?.first, biography: !!p?.bio, confirmationReused: !!p && p.email === p.confirm,
          crossPageReused: !!p && !!r && p.email === r.receipt,
          differentRecipient: !!p && !!r && p.email !== r.recipient };
      })()`)
          : {
              noInventedCredentials: await page.evaluate(
                `![...document.querySelectorAll('input')].some(e => e.value)`,
              ),
            };
      await writeFile(
        path.join(output, `${scenario}.json`),
        JSON.stringify({ result, decisions, checks }, null, 2),
      );
      console.log(
        JSON.stringify({
          scenario,
          reason: result.reason,
          actions: result.actions,
          requests: result.requests,
          checks,
          output,
        }),
      );
      if (demo) await delay(2000);
    } finally {
      await context.close();
      if (video) {
        await video.saveAs(path.join(output, `${scenario}.webm`));
        await video.delete();
      }
    }
  }
} finally {
  await browser.close();
  await site.close();
}
