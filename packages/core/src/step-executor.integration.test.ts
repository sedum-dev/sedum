import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserContextSession,
  type BrowserPage,
  type BrowserSession,
} from "./browser-driver.js";
import { collectCandidates } from "./page-bridge.js";
import type { CandidatePage } from "./page-protocol.js";
import {
  executeStep,
  ResolvedStepTarget,
  RuntimeUrl,
  RuntimeValue,
} from "./step-executor.js";

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "step executors in a real browser",
  () => {
    let server: Server;
    let base = "";
    let session: BrowserSession;

    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/redirect") {
          response.writeHead(302, { location: "/next" });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><html><body><main id='app'></main></body></html>",
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture port");
      base = `http://127.0.0.1:${address.port}`;
      session = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
    });
    afterAll(async () => {
      await session?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function fresh(): Promise<{
      page: BrowserPage;
      context: BrowserContextSession;
    }> {
      const context = await session.newContext({
        viewport: { width: 700, height: 500 },
      });
      const page = await context.newPage();
      await page.goto(base);
      return { page, context };
    }

    function target(snapshot: CandidatePage): ResolvedStepTarget {
      const candidate = snapshot.candidates[0]!;
      return new ResolvedStepTarget({
        ref: candidate.ref,
        version: snapshot.version,
        tag: candidate.tag,
        name: candidate.name,
      });
    }

    it("clicks a native link, observes navigation, and does not replay a canceled link", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        `document.querySelector('#app').innerHTML = '<a href="/redirect">Next</a>'`,
      );
      const snapshot = await collectCandidates(page, "click");
      const result = await executeStep(page, {
        op: "click",
        target: target(snapshot),
      });
      expect(result.outcome).toBe("route_changed");
      expect(page.url).toBe(`${base}/next`);

      await page.evaluate(
        `document.querySelector('#app').innerHTML = '<a href="/again" onclick="event.preventDefault();window.clicks=(window.clicks||0)+1">Stay</a>'`,
      );
      const canceled = await collectCandidates(page, "click");
      const second = await executeStep(page, {
        op: "click",
        target: target(canceled),
      });
      expect(second.outcome).toBe("no_route_change");
      expect(page.url).toBe(`${base}/next`);
      expect(await page.evaluate<number>("window.clicks")).toBe(1);
      await context.close();
    });

    it("notices a client-side route after click and Enter", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`(() => {
        const app = document.querySelector('#app');
        app.innerHTML = '<button id="spa">SPA</button><input aria-label="Search">';
        app.querySelector('#spa').addEventListener('click', () => history.pushState({}, '', '/spa'));
        window.enterCount = 0;
        app.querySelector('input').addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            window.enterCount++;
            history.pushState({}, '', '/entered');
          }
        });
      })()`);
      const snapshot = await collectCandidates(page, "click");
      const clicked = await executeStep(page, {
        op: "click",
        target: target(snapshot),
      });
      expect(clicked.outcome).toBe("route_changed");
      await page.evaluate("document.querySelector('input').focus()");
      const pressed = await executeStep(page, { op: "press", key: "Enter" });
      expect(pressed.outcome).toBe("route_changed");
      expect(page.url).toBe(`${base}/entered`);
      expect(await page.evaluate<number>("window.enterCount")).toBe(1);
      await context.close();
    });

    it("replaces a field value, emits input, and fails safe on a cloned ref", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        `document.querySelector('#app').innerHTML = '<input aria-label="Password" value="old"><output></output>'; window.inputs=0; document.querySelector('input').addEventListener('input', () => {window.inputs++; document.querySelector('output').textContent = 'changed'})`,
      );
      const snapshot = await collectCandidates(page, "fill");
      const value = new RuntimeValue("distinctive-secret", "{{password}}");
      const result = await executeStep(page, {
        op: "type",
        target: target(snapshot),
        value,
      });
      expect(result.outcome).toBe("acted");
      expect(
        await page.evaluate<string>("document.querySelector('input').value"),
      ).toBe("distinctive-secret");
      expect(
        await page.evaluate<string>(
          "document.querySelector('output').textContent",
        ),
      ).toBe("changed");
      expect(await page.evaluate<number>("window.inputs")).toBe(1);
      expect(JSON.stringify(result)).not.toContain("distinctive-secret");

      const next = await collectCandidates(page, "fill");
      await page.evaluate(
        "document.querySelector('input').replaceWith(document.querySelector('input').cloneNode(true))",
      );
      await expect(
        executeStep(page, {
          op: "type",
          target: target(next),
          value: new RuntimeValue("should-not-appear"),
        }),
      ).rejects.toMatchObject({ code: "stale", retryable: true });
      expect(
        await page.evaluate<string>("document.querySelector('input').value"),
      ).toBe("distinctive-secret");

      const changedName = await collectCandidates(page, "fill");
      await page.evaluate(
        "document.querySelector('input').setAttribute('aria-label', 'Other')",
      );
      await expect(
        executeStep(page, {
          op: "type",
          target: target(changedName),
          value: new RuntimeValue("should-not-appear"),
        }),
      ).rejects.toMatchObject({ code: "stale", retryable: true });

      const changedRoute = await collectCandidates(page, "fill");
      await page.evaluate("history.pushState({}, '', '/route-changed')");
      await expect(
        executeStep(page, {
          op: "type",
          target: target(changedRoute),
          value: new RuntimeValue("should-not-appear"),
        }),
      ).rejects.toMatchObject({ code: "stale", retryable: true });

      await page.evaluate(
        `document.querySelector('#app').innerHTML = '<select aria-label="Choice"><option>First</option></select>'`,
      );
      const select = await collectCandidates(page, "fill");
      await expect(
        executeStep(page, {
          op: "type",
          target: target(select),
          value: new RuntimeValue("Second"),
        }),
      ).rejects.toMatchObject({ code: "stale", retryable: true });
      await context.close();
    });

    it("navigates with a safe display URL, emits one wheel, and honors explicit wait", async () => {
      const { page, context } = await fresh();
      const value = new RuntimeValue("secret-token", "{{token}}");
      const url = new RuntimeUrl([`${base}/next?token=`, ""], [value]);
      const navigated = await executeStep(page, { op: "goto", url });
      expect(page.url).toBe(`${base}/next?token=secret-token`);
      expect(navigated.displayUrl).toBe(`${base}/next?token={{token}}`);
      expect(JSON.stringify(navigated)).not.toContain("secret-token");
      const badUrl = new RuntimeUrl(
        ["http://[", ""],
        [new RuntimeValue("FAILURE_SECRET")],
      );
      let failure: unknown;
      try {
        await executeStep(page, { op: "goto", url: badUrl });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "operation_failed",
        retryable: false,
      });
      expect(JSON.stringify(failure)).not.toContain("FAILURE_SECRET");
      expect((failure as Error).stack).not.toContain("FAILURE_SECRET");
      await page.evaluate(
        `document.querySelector('#app').innerHTML = '<div style="height:1800px"></div>'; window.wheels=0; window.addEventListener('wheel', () => {window.wheels++; document.querySelector('#app').append('lazy content')}, {once:true})`,
      );
      await executeStep(page, { op: "scroll", deltaY: 600 });
      await expect.poll(() => page.evaluate<number>("window.wheels")).toBe(1);
      expect(await page.text()).toContain("lazy content");
      const waited = await executeStep(page, { op: "wait", durationMs: 10 });
      expect(waited.elapsedMs).toBeGreaterThanOrEqual(9);
      await context.close();
    });
  },
);
