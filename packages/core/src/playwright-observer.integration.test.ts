import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserPage,
  type BrowserSession,
} from "./browser-driver.js";
import { judgeText, resolverPage } from "./snapshot-observation.js";

const enabled = process.env.SEDUM_BROWSER_INTEGRATION === "1";
const url = (html: string): string =>
  `data:text/html,${encodeURIComponent(html)}`;

describe.skipIf(!enabled)("Playwright observation", () => {
  let session: BrowserSession;
  let page: BrowserPage;
  let server: Server;
  let baseUrl: string;
  let lastReferrer = "";

  beforeAll(async () => {
    server = createServer((request, response) => {
      lastReferrer = request.headers.referer ?? "";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        request.url === "/start"
          ? `<a id="target" href="/next">Go to next</a>`
          : `<h1>${request.url}</h1>`,
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
    session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext();
    page = await context.newPage();
  });

  afterAll(async () => {
    await session?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("maps repeated controls to pinned nodes and excludes editable or hidden digest text", async () => {
    await page.goto(
      url(`
      <article><h2>Amber mug</h2><p>$12</p><button onclick="window.clicked='amber'">Add to cart</button></article>
      <article><h2>Blue mug</h2><p>$12</p><button onclick="window.clicked='blue'">Add to cart</button></article>
      <p>Order summary</p><p>API_KEY=visible-secret</p><p hidden>hidden secret</p>
      <label>Coupon <input value="editable secret"></label>
      <a href="/details?token=secret">Details</a>
    `),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    expect(await page.evaluate("window.__sedum === undefined")).toBe(true);
    expect(observation.digest).toContain("Order summary");
    expect(judgeText(observation)).toContain("API_KEY=visible-secret");
    expect(observation.digest).not.toMatch(/hidden secret|editable secret/);
    const amber = observation.candidates.find(
      (candidate) =>
        candidate.name === "Add to cart" &&
        candidate.peers.includes("Amber mug"),
    );
    expect(amber).toBeDefined();
    expect(JSON.stringify(resolverPage(observation))).not.toMatch(
      /token=secret|href|path/,
    );
    expect(page.selectCandidate(amber!.id)).toBe(true);
    expect(await page.clickCandidate(amber!.id)).toEqual({ clicked: true });
    expect(await page.evaluate("window.clicked")).toBe("amber");
  });

  it("uses a plain product title when no heading marks the card", async () => {
    await page.goto(
      url(`<article><div>Amber mug</div><p>$12</p><button onclick="window.clicked='amber'">Add to cart</button></article>
      <article><div>Blue mug</div><p>$12</p><button onclick="window.clicked='blue'">Add to cart</button></article>`),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    const amber = observation.candidates.find((candidate) =>
      candidate.peers.includes("Amber mug"),
    )!;
    expect(await page.clickCandidate(amber.id)).toEqual({ clicked: true });
    expect(await page.evaluate("window.clicked")).toBe("amber");
  });

  it("uses bounded context for flattened div product cards", async () => {
    await page.goto(
      url(`<main><div class="card"><div>Amber mug</div><p>$12</p><button onclick="window.clicked='amber'">Add to cart</button></div>
      <div class="card"><div>Blue mug</div><p>$12</p><button onclick="window.clicked='blue'">Add to cart</button></div></main>`),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    const amber = observation.candidates.find((candidate) =>
      candidate.peers.includes("Amber mug"),
    )!;
    expect(amber).toBeDefined();
    expect(await page.clickCandidate(amber.id)).toEqual({ clicked: true });
    expect(await page.evaluate("window.clicked")).toBe("amber");
  });

  it("fails closed when repeated controls have no unique semantic item", async () => {
    await page.goto(url(`<button>Add</button><button>Add</button>`));
    expect(await page.observe("click")).toMatchObject({
      complete: false,
      reason: "mapping_ambiguous",
      candidates: [],
    });
  });

  it("rejects a rerendered clone before final click", async () => {
    await page.goto(
      url(`<button id="target" onclick="window.clicked=true">Submit</button>`),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    const candidate = observation.candidates[0]!;
    page.selectCandidate(candidate.id);
    await page.evaluate(
      "document.querySelector('#target').outerHTML = document.querySelector('#target').outerHTML",
    );
    expect(await page.clickCandidate(candidate.id)).toMatchObject({
      clicked: false,
      reason: "stale",
    });
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  });

  it("rejects a same-node meaning change and unrelated occlusion before click", async () => {
    await page.goto(
      url(`<button id="target" onclick="window.clicked=true">Submit</button>`),
    );
    let observation = await page.observe("click");
    const first = observation.candidates[0]!;
    await page.evaluate(
      "document.querySelector('#target').setAttribute('aria-label', 'Delete')",
    );
    expect(await page.clickCandidate(first.id)).toMatchObject({
      clicked: false,
      reason: "stale",
    });
    await page.evaluate(
      "document.querySelector('#target').removeAttribute('aria-label')",
    );
    observation = await page.observe("click");
    const second = observation.candidates[0]!;
    await page.evaluate(
      `(() => { const overlay = document.createElement('div'); overlay.style.cssText='position:fixed;inset:0;background:red;z-index:999'; document.body.append(overlay); })()`,
    );
    expect(await page.clickCandidate(second.id)).toMatchObject({
      clicked: false,
    });
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  });

  it("rejects a disabled target that becomes enabled with a different meaning", async () => {
    await page.goto(
      url(
        `<button id="target" disabled onclick="window.clicked=true">Buy Amber</button>`,
      ),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    expect(observation.candidates[0]?.disabled).toBe(true);
    await page.evaluate(
      "(() => { const target = document.querySelector('#target'); target.disabled = false; target.textContent = 'Buy Blue'; })()",
    );
    expect(
      await page.clickCandidate(observation.candidates[0]!.id),
    ).toMatchObject({ clicked: false, reason: "stale" });
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  });

  it("rejects attribute-only target and ancestor changes omitted by ARIA snapshots", async () => {
    await page.goto(
      url(
        `<article class="original"><button class="buy" onclick="window.clicked=true">Buy</button></article>`,
      ),
    );
    let observation = await page.observe("click");
    await page.evaluate(
      "document.querySelector('button').className = 'delete'",
    );
    expect(
      await page.clickCandidate(observation.candidates[0]!.id),
    ).toMatchObject({ clicked: false, reason: "stale" });
    await page.evaluate("document.querySelector('button').className = 'buy'");
    observation = await page.observe("click");
    await page.evaluate(
      "document.querySelector('article').className = 'changed'",
    );
    expect(
      await page.clickCandidate(observation.candidates[0]!.id),
    ).toMatchObject({ clicked: false, reason: "stale" });
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  });

  it("retains all 130 candidates while offering at most 128 to Resolver", async () => {
    const buttons = Array.from(
      { length: 130 },
      (_, index) => `<button>Item ${index}</button>`,
    ).join("");
    await page.goto(url(buttons));
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    expect(observation.candidates).toHaveLength(130);
    expect(resolverPage(observation).candidates).toHaveLength(128);
    expect(resolverPage(observation).next).toBe(128);
  });

  it("records modal scope behavior before relying on it", async () => {
    await page.goto(
      url(
        `<button>Background</button><dialog><button>Inside</button></dialog><script>document.querySelector('dialog').showModal()</script>`,
      ),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    expect(observation.candidates.map((candidate) => candidate.name)).toContain(
      "Inside",
    );
    expect(
      observation.candidates.map((candidate) => candidate.name),
    ).not.toContain("Background");
    expect(judgeText(observation)).toContain("Inside");
    expect(judgeText(observation)).not.toContain("Background");
  });

  it("preserves a selected lease through resnapshot and releases unselected leases", async () => {
    await page.goto(url(`<button>Alpha</button><button>Beta</button>`));
    const first = await page.observe("click");
    const alpha = first.candidates.find(
      (candidate) => candidate.name === "Alpha",
    )!;
    const beta = first.candidates.find(
      (candidate) => candidate.name === "Beta",
    )!;
    expect(page.selectCandidate(alpha.id)).toBe(true);
    await page.observe("click");
    expect(await page.clickCandidate(beta.id)).toMatchObject({
      clicked: false,
      reason: "target_missing",
    });
    expect(await page.clickCandidate(alpha.id)).toEqual({ clicked: true });
  });

  it("invalidates a selected target on a route-only SPA change", async () => {
    await page.goto(`${baseUrl}/start`);
    const observation = await page.observe("click");
    const target = observation.candidates[0]!;
    page.selectCandidate(target.id);
    await page.evaluate("history.pushState({}, '', '/other')");
    expect(await page.clickCandidate(target.id)).toMatchObject({
      clicked: false,
    });
    expect(page.url).toBe(`${baseUrl}/other`);
  });

  it("uses native link cancellation and navigation behavior", async () => {
    for (const cancellation of [
      "event.preventDefault()",
      "Event.prototype.preventDefault.call(event)",
      "window.cachedPreventDefault.call(event)",
    ]) {
      await page.goto(`${baseUrl}/start`);
      await page.evaluate(
        `window.cachedPreventDefault = Event.prototype.preventDefault; document.querySelector('#target').addEventListener('click', event => { ${cancellation}; });`,
      );
      const observation = await page.observe("click");
      expect(await page.clickCandidate(observation.candidates[0]!.id)).toEqual({
        clicked: true,
      });
      expect(page.url).toBe(`${baseUrl}/start`);
    }
    await page.goto(`${baseUrl}/start`);
    const observation = await page.observe("click");
    expect(await page.clickCandidate(observation.candidates[0]!.id)).toEqual({
      clicked: true,
    });
    expect(page.url).toBe(`${baseUrl}/next`);
    expect(lastReferrer).toBe(`${baseUrl}/start`);
    await page.goto(`${baseUrl}/start`);
    await page.evaluate(
      "document.querySelector('#target').setAttribute('referrerpolicy', 'no-referrer')",
    );
    const privateLink = await page.observe("click");
    expect(await page.clickCandidate(privateLink.candidates[0]!.id)).toEqual({
      clicked: true,
    });
    expect(page.url).toBe(`${baseUrl}/next`);
    expect(lastReferrer).toBe("");
  });

  it("records native navigation after a capture handler changes href", async () => {
    await page.goto(`${baseUrl}/start`);
    await page.evaluate(
      "document.addEventListener('click', () => { document.querySelector('#target').href='/changed'; }, true)",
    );
    const observation = await page.observe("click");
    expect(await page.clickCandidate(observation.candidates[0]!.id)).toEqual({
      clicked: true,
    });
    expect(page.url).toBe(`${baseUrl}/changed`);
  });

  it("waits through a short delayed render and rejects pointer-events-disabled controls", async () => {
    await page.goto(
      url(
        `<script>setTimeout(() => { document.body.innerHTML='<button>Ready</button>'; }, 50)</script>`,
      ),
    );
    const ready = await page.observe("click");
    expect(ready.complete).toBe(true);
    expect(ready.candidates.map((candidate) => candidate.name)).toEqual([
      "Ready",
    ]);
    await page.goto(
      url(`<button style="pointer-events:none">Disabled pointer</button>`),
    );
    const blocked = await page.observe("click");
    expect(blocked.complete).toBe(true);
    expect(await page.clickCandidate(blocked.candidates[0]!.id)).toMatchObject({
      clicked: false,
      reason: "not_actionable",
    });
  });

  it("scrolls to an offscreen target and rejects a scroll-triggered relabel", async () => {
    await page.goto(
      url(
        `<button style="margin-top:2000px" onclick="window.clicked=true">Offscreen</button>`,
      ),
    );
    let observation = await page.observe("click");
    expect(await page.clickCandidate(observation.candidates[0]!.id)).toEqual({
      clicked: true,
    });
    expect(await page.evaluate("window.clicked === true")).toBe(true);
    await page.goto(
      url(`<button id="target" style="margin-top:2000px" onclick="window.clicked=true">Buy Amber</button>
      <script>window.addEventListener('scroll', () => document.querySelector('#target').setAttribute('aria-label', 'Buy Blue'), {once:true})</script>`),
    );
    observation = await page.observe("click");
    expect(
      await page.clickCandidate(observation.candidates[0]!.id),
    ).toMatchObject({ clicked: false, reason: "stale" });
    expect(await page.evaluate("window.clicked === true")).toBe(false);
  });

  it("fails closed on ambiguous modal scopes and an oversized visible digest", async () => {
    await page.goto(
      url(
        `<div role="dialog" aria-modal="true"><button>First</button></div><div role="dialog" aria-modal="true"><button>Second</button></div>`,
      ),
    );
    expect(await page.observe("click")).toMatchObject({
      complete: false,
      reason: "scope_ambiguous",
      candidates: [],
    });
    await page.goto(url(`<p>${"A".repeat(4097)}</p><button>Go</button>`));
    expect(await page.observe("click")).toMatchObject({
      complete: false,
      reason: "digest_incomplete",
      candidates: [],
    });
    await page.goto(url(`<p id="large"></p><button>Go</button>`));
    await page.evaluate(
      "document.querySelector('#large').textContent = 'B'.repeat(1100000)",
    );
    expect(
      await page.evaluate(
        "document.querySelector('#large').textContent.length",
      ),
    ).toBe(1_100_000);
    expect(await page.observe("click")).toMatchObject({
      complete: false,
      reason: "resource_ceiling",
      candidates: [],
    });
  });

  it("offers read and fill candidates without an editable value", async () => {
    await page.goto(
      url(
        `<h1>Order summary</h1><p>Amber mug added</p><label>Coupon <input value="private coupon"></label>`,
      ),
    );
    const read = await page.observe("read");
    expect(read.complete).toBe(true);
    expect(read.candidates.map((candidate) => candidate.name)).toEqual([
      "Order summary",
      "Amber mug added",
    ]);
    const fill = await page.observe("fill");
    expect(fill.complete).toBe(true);
    expect(fill.candidates).toHaveLength(1);
    expect(fill.candidates[0]).toMatchObject({
      role: "textbox",
      name: "Coupon",
      editable: true,
    });
    expect(JSON.stringify(resolverPage(fill))).not.toContain("private coupon");
  });

  it("excludes content-visibility hidden text and refuses nested controls in unsupported links", async () => {
    await page.goto(
      url(
        `<p style="content-visibility:hidden">hidden token</p><p>Visible text</p><a href="https://example.test/" target="_blank"><button>Nested</button></a>`,
      ),
    );
    const observation = await page.observe("click");
    expect(observation.complete).toBe(true);
    expect(judgeText(observation)).toContain("Visible text");
    expect(judgeText(observation)).not.toContain("hidden token");
    const nested = observation.candidates.find(
      (candidate) => candidate.name === "Nested",
    )!;
    expect(await page.clickCandidate(nested.id)).toMatchObject({
      clicked: false,
      reason: "not_actionable",
    });
  });

  it("releases a selected lease after incomplete observation and page close", async () => {
    await page.goto(url(`<button>Proceed</button>`));
    const first = await page.observe("click");
    const selected = first.candidates[0]!;
    page.selectCandidate(selected.id);
    await page.evaluate(
      `document.body.insertAdjacentHTML('beforeend', '<p>${"Z".repeat(4097)}</p>')`,
    );
    expect(await page.observe("click")).toMatchObject({
      complete: false,
      reason: "digest_incomplete",
    });
    expect(await page.clickCandidate(selected.id)).toMatchObject({
      clicked: false,
      reason: "target_missing",
    });
    await page.goto(url(`<button>Proceed</button>`));
    const second = await page.observe("click");
    const closing = second.candidates[0]!;
    page.selectCandidate(closing.id);
    await page.close();
    expect(await page.clickCandidate(closing.id)).toMatchObject({
      clicked: false,
      reason: "target_missing",
    });
  });
});
