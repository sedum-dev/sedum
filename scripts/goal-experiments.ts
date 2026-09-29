/** Opt-in bounded live experiments: bun scripts/goal-experiments.ts [local|public|sauce|serve] */
import { readFile, mkdir, writeFile, readdir, rename } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { startFixtureSite } from "../fixtures/site/server.ts";
import {
  PlaywrightBrowserDriver,
  parseFlow,
  resolveData,
  runGoal,
  type GoalOptions,
  type BrowserPage,
} from "../packages/core/dist/index.js";
import { TypeSafeAdapter } from "../packages/provider-typesafe/dist/index.js";

const mode = process.argv[2] ?? "local";
const artifacts = path.resolve(".amp/in/artifacts/goal-mode");
if (mode === "serve") {
  const site = await startFixtureSite();
  createServer(async (req, res) => {
    try {
      const route = !req.url || req.url === "/" ? "/login" : req.url;
      const reply = await fetch(site.baseUrl + route);
      res.writeHead(reply.status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(await reply.text());
    } catch {
      res.writeHead(502);
      res.end("Fixture unavailable");
    }
  }).listen(4174, "0.0.0.0", () =>
    console.log("Existing Sedum checkout fixture listening on 4174"),
  );
} else {
  if (!["local", "public", "sauce"].includes(mode))
    throw new Error("Choose local, public, sauce, or serve");
  await mkdir(artifacts, { recursive: true });
  const local = parseFlow(
    await readFile("fixtures/ui-login-checkout.test.yaml", "utf8"),
    "fixtures/ui-login-checkout.test.yaml",
    { repoRoot: process.cwd() },
  ).value!;
  const sauce = parseFlow(
    await readFile("fixtures/saucedemo-checkout.test.yaml", "utf8"),
    "fixtures/saucedemo-checkout.test.yaml",
    { repoRoot: process.cwd() },
  ).value!;
  // Disposable documented fixture credentials only. Real credentials remain in the provider adapter.
  const localData = resolveData(
    {
      ...local.data,
      password: {
        value: "$FIXTURE_PASSWORD",
        source: {
          file: "fixtures/modules/ui-login.module.yaml",
          line: 1,
          col: 1,
        },
      },
    },
    { FIXTURE_PASSWORD: "fixture_password" },
  );
  const sauceData = resolveData(sauce.data, { SAUCE_PASSWORD: "secret_sauce" });
  interface Experiment {
    id: string;
    url: string;
    options: GoalOptions;
    check: string;
    video?: boolean;
    requiredPaths?: readonly string[];
  }
  const checkoutGoal =
    "Sign in using username and password bindings, buy exactly one Canvas Backpack (not Trail Light), and complete the demo checkout with first, last and postal bindings. Stop when Order placed is shown.";
  const experiments: Experiment[] =
    mode === "local"
      ? [
          {
            id: "fixture-checkout",
            url: "http://127.0.0.1:4174/login",
            video: true,
            options: {
              goal: checkoutGoal,
              verify: ["Order placed is shown"],
              data: localData,
            },
            check: `document.querySelector('#confirmation')?.textContent === 'Order placed' && sessionStorage.getItem('cart') === null && document.querySelector('[name=first]')?.value === 'Ada' && document.querySelector('[name=last]')?.value === 'Example' && document.querySelector('[name=postal]')?.value === '94016'`,
          },
          {
            id: "fixture-action-limit",
            url: "http://127.0.0.1:4174/login",
            options: {
              goal: checkoutGoal,
              verify: ["Order placed is shown"],
              data: localData,
              maxActions: 2,
            },
            check: `document.querySelector('#confirmation')?.textContent === 'Order placed'`,
          },
          {
            id: "fixture-false-verification",
            url: "http://127.0.0.1:4174/login",
            options: {
              goal: "Observe the visible Sign in heading. Do not sign in or perform any other actions.",
              verify: ["An order confirmation saying Order placed is visible"],
              data: localData,
            },
            check: `document.querySelector('#confirmation')?.textContent === 'Order placed'`,
          },
        ]
      : mode === "sauce"
        ? [
            {
              id: "saucedemo-checkout",
              url: sauce.url!,
              requiredPaths: [
                "/inventory.html",
                "/cart.html",
                "/checkout-step-one.html",
                "/checkout-step-two.html",
                "/checkout-complete.html",
              ],
              options: {
                goal: "Complete the entire authorized Sauce Demo checkout. All data bindings are supplied, including the secret password which the executor can fill without revealing it. Log in with {{user}} and {{password}}. Put exactly one Sauce Labs Backpack and one Sauce Labs Onesie in the cart, with no other products. Open the cart and checkout. Use {{first_name}}, {{last_name}}, and {{postcode}} for the customer information. Review the order summary, then finish the demo order. Stop only when the Thank you for your order! confirmation is visible.",
                verify: [
                  "The checkout is complete: Thank you for your order! is visible and the order has been dispatched message is shown",
                ],
                data: sauceData,
                maxActions: 20,
                maxRequests: 26,
              },
              check: `location.pathname === '/checkout-complete.html' && document.querySelector('[data-test=complete-header]')?.textContent === 'Thank you for your order!'`,
            },
          ]
        : [
            {
              id: "iana-domain-research",
              url: "https://www.iana.org/",
              requiredPaths: [
                "/domains",
                "/domains/int",
                "/domains/int/policy",
                "/domains/arpa",
                "/domains/reserved",
              ],
              options: {
                goal: "Read-only research on IANA's live website. Starting from the homepage, visit the Domain Name Services overview, then the .INT Registry overview, then its Eligibility policy. After reading eligibility, visit the .ARPA Registry overview to review infrastructure domain uses. Finally open Reserved Domains and stop on IANA-managed Reserved Domains with its Example domains section visible. Visit these five destinations in that order; do not skip directly to the final page. Prefer the sidebar navigation links when available. Do not register, modify, submit forms, or contact anyone.",
                verify: [
                  "The IANA-managed Reserved Domains page is open and its Example domains section explains that example.com and example.org are maintained for documentation purposes",
                ],
                allowedClickNames: [
                  "Domain Names",
                  ".INT Registry",
                  "Eligibility",
                  ".ARPA Registry",
                  "Reserved Domains",
                ],
              },
              check: `location.hostname === 'www.iana.org' && location.pathname === '/domains/reserved' && document.querySelector('h1')?.textContent.trim() === 'IANA-managed Reserved Domains' && document.body.innerText.includes('Example domains')`,
            },
            {
              id: "iana-domain-survey",
              url: "https://www.iana.org/",
              requiredPaths: [
                "/domains",
                "/domains/int",
                "/domains/arpa",
                "/domains/reserved",
                "/domains",
              ],
              options: {
                goal: "Read-only survey of specialized domains on IANA's live website. Starting from the homepage, open the Domain Name Services overview, then the .INT Registry overview, then the .ARPA Registry overview, then Reserved Domains. Finish by returning to the Domain Name Services overview. Visit all five destinations in that order, including the final return; do not skip directly to the final page. Stay on the overview pages rather than opening detailed policies or RFCs. Prefer sidebar links when available. Do not register, modify, submit forms, or contact anyone.",
                verify: [
                  "The Domain Name Services overview is open, listing The DNS Root Zone, .INT, .ARPA, and Reserved Domains",
                ],
                allowedClickNames: [
                  "Domain Names",
                  ".INT Registry",
                  ".ARPA Registry",
                  "Reserved Domains",
                  "Overview",
                ],
              },
              check: `location.hostname === 'www.iana.org' && location.pathname === '/domains' && document.querySelector('h1')?.textContent.trim() === 'Domain Name Services'`,
            },
            {
              id: "books-travel",
              url: "https://books.toscrape.com/",
              options: {
                allowedClickNames: ["Travel", "It's Only the Himalayas"],
                goal: "Read-only browsing: open the Travel category and then open the book It's Only the Himalayas. Do not add to a basket or purchase anything.",
                verify: [
                  "The book detail page for It's Only the Himalayas is open, with its product information",
                ],
              },
              check: `location.pathname.includes('its-only-the-himalayas') && document.querySelector('h1')?.textContent === "It's Only the Himalayas"`,
            },
            {
              id: "quotes-einstein",
              url: "https://quotes.toscrape.com/",
              options: {
                allowedClickNames: ["(about)"],
                goal: "Read-only browsing: open Albert Einstein's author biography using the about link. Do not sign in or submit anything.",
                verify: [
                  "Albert Einstein's author biography is open, including his birth information and description",
                ],
              },
              check: `location.pathname === '/author/Albert-Einstein/' && document.querySelector('.author-title')?.textContent.trim() === 'Albert Einstein'`,
            },
            {
              id: "wikipedia-search",
              url: "https://www.wikipedia.org/",
              options: {
                allowedClickNames: ["Search", "Sedum"],
                goal: "Read-only search: search for Sedum using the query binding and open the encyclopedia article about the genus Sedum. Do not edit or sign in.",
                verify: [
                  "The encyclopedia article about the plant genus Sedum is open",
                ],
                data: resolveData(
                  {
                    query: {
                      value: "Sedum",
                      source: { file: "experiment", line: 1, col: 1 },
                    },
                  },
                  {},
                ),
              },
              check: `location.hostname === 'en.wikipedia.org' && location.pathname === '/wiki/Sedum' && document.querySelector('h1')?.textContent === 'Sedum'`,
            },
          ];
  const adapter = new TypeSafeAdapter({ model: "jev-latest" });
  const variant =
    process.argv.find((arg) => arg.startsWith("--context="))?.slice(10) ??
    "baseline";
  if (
    !["baseline", "data", "instructions", "completion", "all"].includes(variant)
  )
    throw new Error("Unknown goal context experiment");
  const shortGoal = process.argv.includes("--short-goal");
  const anyProduct = process.argv.includes("--any-product");
  const credentials =
    process.argv.includes("--credentials") || anyProduct || shortGoal;
  const simple = process.argv.includes("--simple") || credentials;
  const operationMinMargin = process.argv.includes("--lower-operation-margin")
    ? 0.03
    : 0.1;
  const slowMoMs = process.argv.includes("--demo") ? 150 : 0;
  const demoPauseMs = process.argv.includes("--demo") ? 750 : 0;
  const browser = await new PlaywrightBrowserDriver().launch({
    browser: "chromium",
    slowMoMs,
  });
  try {
    for (const candidate of experiments) {
      if (process.argv[3] && candidate.id !== process.argv[3]) continue;
      let experiment = candidate;
      if (simple) {
        if (candidate.id === "saucedemo-checkout") {
          const { user, ...checkoutData } = sauce.data;
          experiment = {
            ...candidate,
            id: shortGoal
              ? "saucedemo-short"
              : anyProduct
                ? "saucedemo-any-product"
                : credentials
                  ? "saucedemo-explicit-bindings"
                  : "saucedemo-simple",
            options: {
              ...candidate.options,
              goal: shortGoal
                ? "Sign in and complete checkout"
                : anyProduct
                  ? "Sign in with username: {{username}} and password: {{password}} and complete the checkout flow. You may select any product."
                  : credentials
                    ? "Sign in with username: {{username}} and password: {{password}} and complete the checkout flow"
                    : "Sign in and complete the checkout flow",
              ...(credentials
                ? {
                    data: resolveData(
                      { ...checkoutData, username: user! },
                      { SAUCE_PASSWORD: "secret_sauce" },
                    ),
                  }
                : {}),
            },
          };
        } else if (candidate.id === "iana-domain-survey")
          experiment = {
            ...candidate,
            id: "iana-simple",
            requiredPaths: ["/domains/reserved"],
            options: {
              ...candidate.options,
              goal: "Find information about IANA's reserved domain names.",
              verify: [
                "The IANA-managed Reserved Domains page is open and its Example domains section explains that example.com and example.org are maintained for documentation purposes",
              ],
            },
            check: `location.hostname === 'www.iana.org' && location.pathname === '/domains/reserved' && document.querySelector('h1')?.textContent.trim() === 'IANA-managed Reserved Domains'`,
          };
        else
          throw new Error(
            "Simple goals are defined only for Sauce Demo and IANA survey",
          );
      }
      const runId = `${experiment.id}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
      const videoDir = path.join(artifacts, runId);
      const recordVideo = experiment.video || process.argv.includes("--demo");
      if (recordVideo) await mkdir(videoDir, { recursive: true });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ...(recordVideo
          ? {
              recordVideo: {
                dir: videoDir,
                size: { width: 1280, height: 720 },
              },
            }
          : {}),
      });
      let page: BrowserPage | undefined;
      try {
        page = await context.newPage();
        await page.goto(experiment.url, {
          timeoutMs: 25_000,
          waitUntil: "domcontentloaded",
        });
        // Read-only audit observes exact cart contents before completion clears them.
        const cartSnapshots: string[][] = [];
        const visitedPaths: string[] = [];
        let sauceDetailsChecked = false;
        let sauceSummaryChecked = false;
        let sauceItems: string[] = [];
        const decisions: { operation: unknown; target: unknown }[] = [];
        const planner = {
          chooseGoal: async (
            ...args: Parameters<typeof adapter.chooseGoal>
          ) => {
            // Visible real-time dwell, not edited footage; included in reported timings.
            if (demoPauseMs)
              await new Promise((resolve) => setTimeout(resolve, demoPauseMs));
            visitedPaths.push(new URL(page!.url).pathname);
            if (mode === "sauce") {
              if (new URL(page!.url).pathname === "/checkout-step-two.html")
                sauceItems = await page!.evaluate<string[]>(
                  `[...document.querySelectorAll('.cart_item .inventory_item_name')].map(item => item.textContent)`,
                );
              sauceDetailsChecked ||= await page!.evaluate<boolean>(
                `location.pathname === '/checkout-step-one.html' && document.querySelector('[data-test=firstName]')?.value === 'Ada' && document.querySelector('[data-test=lastName]')?.value === 'Lovelace' && document.querySelector('[data-test=postalCode]')?.value === '94016'`,
              );
              sauceSummaryChecked ||= await page!.evaluate<boolean>(`(() => {
                if (location.pathname !== '/checkout-step-two.html') return false;
                const items = [...document.querySelectorAll('.cart_item')];
                const names = items.map(item => item.querySelector('.inventory_item_name')?.textContent).sort();
                if (${simple}) return !!document.querySelector('.summary_total_label');
                return JSON.stringify(names) === JSON.stringify(['Sauce Labs Backpack','Sauce Labs Onesie']) && items.every(item => item.querySelector('.cart_quantity')?.textContent === '1') && document.querySelector('.summary_subtotal_label')?.textContent === 'Item total: $37.98';
              })()`);
            }
            if (mode === "local")
              cartSnapshots.push(
                await page!.evaluate(
                  `JSON.parse(sessionStorage.getItem('cart') || '[]')`,
                ),
              );
            const decision = await adapter.chooseGoal(
              {
                ...args[0],
                ...(variant === "data" || variant === "all"
                  ? {
                      declaredDataKeys: Object.keys(
                        experiment.options.data ?? {},
                      ).sort(),
                    }
                  : {}),
                ...(variant === "instructions" || variant === "all"
                  ? {
                      operationInstructions:
                        "Use the current field binding matches and actions already taken. Do not repeat a step that is already satisfied, and do not retype a field that already holds the wanted value. Fill the required fields before submitting. BLOCKED means no available operation can make progress.",
                    }
                  : {}),
                ...(variant === "completion" || variant === "all"
                  ? { completionCriteria: experiment.options.verify }
                  : {}),
              },
              args[1],
            );
            // Provider-validated finite choice IDs and numbers only, never page or binding values.
            decisions.push({
              operation: decision.operation,
              target: decision.target,
            });
            return decision;
          },
        };
        const result = await runGoal(page, planner, adapter, {
          maxRequests: 24,
          maxActions: 18,
          timeoutMs: 120_000,
          ...experiment.options,
          operationMinMargin,
        });
        const domCheck = await page.evaluate<boolean>(experiment.check);
        visitedPaths.push(new URL(page.url).pathname);
        let reached = 0;
        for (const pathname of visitedPaths)
          if (pathname === experiment.requiredPaths?.[reached]) reached++;
        const pathSequenceCheck = experiment.requiredPaths
          ? reached === experiment.requiredPaths.length
          : null;
        const sauceCheckoutCheck =
          mode === "sauce" ? sauceDetailsChecked && sauceSummaryChecked : null;
        const exactCart =
          experiment.id === "fixture-checkout"
            ? cartSnapshots.some(
                (items) => items.length === 1 && items[0] === "Canvas Backpack",
              ) &&
              cartSnapshots.every(
                (items) =>
                  items.length <= 1 &&
                  items.every((item) => item === "Canvas Backpack"),
              )
            : null;
        const independentOutcome =
          domCheck &&
          exactCart !== false &&
          pathSequenceCheck !== false &&
          sauceCheckoutCheck !== false;
        const report = {
          id: experiment.id,
          startedAt: runId,
          goal: experiment.options.goal,
          claims: experiment.options.verify,
          requestedModel: "jev-latest",
          contextVariant: variant,
          operationMinMargin,
          decisions,
          slowMoMs,
          demoPauseMs,
          budgets: {
            maxRequests: experiment.options.maxRequests ?? 24,
            maxActions: experiment.options.maxActions ?? 18,
            timeoutMs: 120_000,
          },
          ...result,
          plannerStatus: result.status,
          status:
            result.status === "passed" && independentOutcome
              ? "passed"
              : "failed",
          reason:
            result.status === "passed" && !independentOutcome
              ? "independent_check_failed"
              : result.reason,
          httpAttempts: result.calls.reduce((n, c) => n + c.attempts, 0),
          independentDomCheck: domCheck,
          exactCartCheck: exactCart,
          ...(experiment.requiredPaths
            ? {
                requiredPaths: experiment.requiredPaths,
                visitedPaths,
                pathSequenceCheck,
              }
            : {}),
          ...(mode === "sauce"
            ? { sauceDetailsChecked, sauceSummaryChecked, sauceItems }
            : {}),
          independentOutcome,
          inputTokens: result.calls.reduce(
            (n, c) => n + c.usage.inputTokens,
            0,
          ),
          outputTokens: result.calls.reduce(
            (n, c) => n + c.usage.outputTokens,
            0,
          ),
          estimatedCostUsd: result.calls.every((c) => c.totalCostUsd !== null)
            ? result.calls.reduce((n, c) => n + c.totalCostUsd!, 0)
            : null,
        };
        await writeFile(
          path.join(artifacts, `${runId}.json`),
          JSON.stringify(report, null, 2) + "\n",
        );
        if (recordVideo && page.captureFrame)
          await writeFile(
            path.join(artifacts, `${runId}.png`),
            await page.captureFrame(),
          );
        if (recordVideo)
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        console.log(
          JSON.stringify({
            id: experiment.id,
            status: report.status,
            reason: report.reason,
            requests: result.requests,
            actions: result.actions,
            elapsedMs: result.elapsedMs,
            independentOutcome: report.independentOutcome,
            tokens: report.inputTokens,
            cost: report.estimatedCostUsd,
          }),
        );
      } catch {
        // Do not serialize raw navigation/provider exceptions or URLs with runtime data.
        const failure = {
          id: experiment.id,
          goal: experiment.options.goal,
          status: "failed",
          reason: "navigation_or_harness_error",
          independentOutcome: false,
        };
        await writeFile(
          path.join(artifacts, `${runId}.json`),
          JSON.stringify(failure, null, 2) + "\n",
        );
        console.log(JSON.stringify(failure));
      } finally {
        await context.close();
        if (recordVideo) {
          const videos = (await readdir(videoDir)).filter((file) =>
            file.endsWith(".webm"),
          );
          if (videos.length === 1)
            await rename(
              path.join(videoDir, videos[0]!),
              path.join(videoDir, "continuous-demo.webm"),
            );
        }
      }
    }
  } finally {
    await browser.close();
  }
}
