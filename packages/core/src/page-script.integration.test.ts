import { createServer, type Server } from "node:http";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "./browser-driver.js";
import {
  clickTarget,
  collectCandidates,
  liveCandidates,
  matchLiveEntry,
  pageDigest,
  pageVersion,
  quietPage,
} from "./page-bridge.js";
import { stageEntry } from "./page-cache.js";
import { projectCandidates } from "./page-protocol.js";

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "built page script",
  () => {
    let server: Server;
    let base = "";
    let session: BrowserSession;
    let lastReferer: string | undefined;
    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/referer-check")
          lastReferer = request.headers.referer;
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
    async function fresh() {
      const context = await session.newContext({
        viewport: { width: 700, height: 500 },
      });
      const page = await context.newPage();
      await page.goto(base);
      return { page, context };
    }
    it("injects on navigation, pages all controls, and rejects a stale cursor", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = Array.from({length:150}, (_,i)=>`<button>Item ${i}</button>`).join('')",
      );
      const first = await collectCandidates(page, "click");
      expect(first.total).toBe(150);
      expect(first.candidates).toHaveLength(128);
      expect(projectCandidates(first)).toHaveLength(128);
      const second = await collectCandidates(
        page,
        "click",
        first.next!,
        first.version,
      );
      expect(second.candidates).toHaveLength(22);
      expect((await liveCandidates(page, "click")).candidates).toHaveLength(
        150,
      );
      await page.evaluate(
        "document.querySelector('#app').setAttribute('class','changed')",
      );
      expect(
        (await collectCandidates(page, "click", first.next!, first.version))
          .complete,
      ).toBe(false);
      await page.goto(`${base}/next`);
      expect((await collectCandidates(page, "click")).total).toBe(0);
      await context.close();
    });
    it("uses card context, preserves authored refs, and excludes input values from digest", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        `document.querySelector('#app').innerHTML = '<article><h2>Camera</h2><span>$10</span><button data-sedum-ref="authored">Add to cart</button></article><article><h2>Phone</h2><span>$10</span><button>Add to cart</button></article><label>Password<input value="secret-input"></label><p>token=VISIBLE</p>'`,
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates).toHaveLength(2);
      expect(found.candidates[0]?.peers[0]).toContain("Camera");
      expect(found.candidates[1]?.peers[0]).toContain("Phone");
      const key = new Uint8Array(32).fill(9);
      const entry = stageEntry(
        key,
        (await pageVersion(page)).route,
        "click",
        "Buy Camera",
        found.candidates[0]!,
        found,
      );
      const matched = await matchLiveEntry(
        page,
        entry,
        key,
        "click",
        "Buy Camera",
      );
      expect(matched.hit).toBe(true);
      if (matched.hit) expect(matched.candidate.peers).toContain("Camera");
      const digest = await pageDigest(page);
      expect(digest.text).toContain("token=VISIBLE");
      expect(digest.text).not.toContain("secret-input");
      await page.evaluate("history.pushState({}, '', '/?token=URLSECRET')");
      expect(JSON.stringify(projectCandidates(found))).not.toContain(
        "URLSECRET",
      );
      expect((await pageDigest(page)).text).not.toContain("URLSECRET");
      const refreshed = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, refreshed.candidates[0]!.ref);
      expect(aimed.actionable).toBe(true);
      if (aimed.actionable)
        expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      await page.evaluate("window.__sedum.clearRefs()");
      expect(
        await page.evaluate(
          "document.querySelector('button').getAttribute('data-sedum-ref')",
        ),
      ).toBe("authored");
      await collectCandidates(page, "click");
      await page.evaluate(
        "document.querySelector('button').setAttribute('data-sedum-ref', 'new-authored'); window.__sedum.clearRefs()",
      );
      expect(
        await page.evaluate(
          "document.querySelector('button').getAttribute('data-sedum-ref')",
        ),
      ).toBe("new-authored");
      await context.close();
    });
    it("rejects a rerendered clone and a route-only SPA change before action", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button onclick=\"window.clicked=(window.clicked||0)+1\">Buy</button>'",
      );
      const first = (await collectCandidates(page, "click")).candidates[0]!;
      const aimed = await clickTarget(page, first.ref);
      expect(aimed.actionable).toBe(true);
      if (!aimed.actionable) throw new Error("No aim");
      await page.evaluate(
        "document.querySelector('button').replaceWith(document.querySelector('button').cloneNode(true))",
      );
      expect((await page.clickRef(aimed.aim)).actionable).toBe(false);
      expect(await page.evaluate("window.clicked || 0")).toBe(0);
      const next = (await collectCandidates(page, "click")).candidates[0]!;
      const nextAim = await clickTarget(page, next.ref);
      if (!nextAim.actionable) throw new Error("No aim after rerender");
      await page.evaluate("history.pushState({}, '', '/other-route')");
      expect((await page.clickRef(nextAim.aim)).actionable).toBe(false);
      expect(await page.evaluate("window.clicked || 0")).toBe(0);
      expect((await pageVersion(page)).route).toContain("/other-route");
      await context.close();
    });
    it("limits modal scope and rejects an unrelated overlay", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button>Outside</button><dialog><button>Inside</button></dialog>'; document.querySelector('dialog').showModal()",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Inside",
      ]);
      const beforeOverlay = await clickTarget(page, found.candidates[0]!.ref);
      expect(beforeOverlay.actionable).toBe(true);
      await page.evaluate(
        "document.querySelector('dialog').insertAdjacentHTML('beforeend', '<div style=\"position:fixed;inset:0;background:white;z-index:9999\"></div>')",
      );
      if (beforeOverlay.actionable)
        expect((await page.clickRef(beforeOverlay.aim)).actionable).toBe(false);
      expect(
        (await clickTarget(page, found.candidates[0]!.ref)).actionable,
      ).toBe(false);
      await context.close();
    });
    it("ignores offscreen nonmodal dialogs and discovers actionable tabs", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        'document.querySelector(\'#app\').innerHTML = \'<dialog open style="position:absolute;left:-5000px"><button>Old</button></dialog><button>Checkout</button><div role="tab fallback" tabindex="0" aria-label="Details"></div>\'',
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Checkout",
        "Details",
      ]);
      expect(found.candidates[1]?.role).toBe("tab");
      expect((await pageDigest(page)).text).not.toContain("Old");
      await context.close();
    });
    it("uses the topmost dialog for candidates and digest", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<dialog id=\"new\"><p>NEW_TEXT</p><button>New</button></dialog><dialog id=\"old\"><p>OLD_SECRET</p><button>Old</button></dialog>'; document.querySelector('#old').showModal(); document.querySelector('#new').showModal(); document.activeElement.blur()",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "New",
      ]);
      const digest = await pageDigest(page);
      expect(digest.text).toContain("NEW_TEXT");
      expect(digest.text).not.toContain("OLD_SECRET");
      await context.close();
    });
    it("fails closed when multiple ARIA modal scopes disagree with focus or stacking", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        'document.querySelector(\'#app\').innerHTML = \'<div role="dialog" aria-modal="true" style="position:fixed;inset:40px;z-index:200;background:white"><p>NEW_TEXT</p><button>New</button></div><div role="dialog" aria-modal="true" style="position:fixed;inset:80px;z-index:100;background:white"><p>OLD_SECRET</p><button>Old</button></div>\'; document.activeElement.blur()',
      );
      const found = await collectCandidates(page, "click");
      expect(found.complete).toBe(false);
      const digest = await pageDigest(page);
      expect(digest.complete).toBe(false);
      expect(digest.error).toBe("scope_ambiguous");
      await page.evaluate(
        "document.querySelectorAll('[role=dialog] button')[1].focus()",
      );
      const focused = await collectCandidates(page, "click");
      expect(focused.complete).toBe(false);
      expect((await pageDigest(page)).error).toBe("scope_ambiguous");
      await context.close();
    });
    it("handles delayed content, offscreen controls, pointer-events, and oversized digest", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "setTimeout(() => document.querySelector('#app').innerHTML = '<div style=\"height:1500px\"></div><button>Late</button>', 60)",
      );
      expect((await quietPage(page, 20, 40)).quiet).toBe(true);
      await page.evaluate("new Promise(resolve => setTimeout(resolve, 100))");
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Late",
      ]);
      const aim = await clickTarget(page, found.candidates[0]!.ref);
      expect(aim.actionable).toBe(true);
      await page.evaluate(
        "document.querySelector('button').style.pointerEvents = 'none'",
      );
      expect(
        (await clickTarget(page, found.candidates[0]!.ref)).actionable,
      ).toBe(false);
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<p>' + 'x'.repeat(4100) + '</p>'",
      );
      expect((await pageDigest(page)).error).toBe("digest_too_large");
      await context.close();
    });
    it("never projects editable text as a name or page digest", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<label>Search<input value=\"password-123\"></label><div contenteditable>draft-secret</div><button>Submit</button>'",
      );
      const fills = await collectCandidates(page, "fill");
      expect(fills.candidates.map((candidate) => candidate.name)).toEqual([
        "Search",
      ]);
      expect(JSON.stringify(projectCandidates(fills))).not.toContain(
        "password-123",
      );
      expect(JSON.stringify(projectCandidates(fills))).not.toContain(
        "draft-secret",
      );
      const digest = await pageDigest(page);
      expect(digest.text).not.toContain("password-123");
      expect(digest.text).not.toContain("draft-secret");
      await context.close();
    });
    it("offers radios for click but not fill", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        'document.querySelector(\'#app\').innerHTML = \'<label><input type="radio" name="size">Large</label><label>Search<input type="text"></label>\'',
      );
      const clicks = await collectCandidates(page, "click");
      expect(clicks.candidates.map((candidate) => candidate.role)).toEqual([
        "radio",
      ]);
      expect(clicks.candidates[0]?.editable).toBe(false);
      const fills = await collectCandidates(page, "fill");
      expect(fills.candidates.map((candidate) => candidate.name)).toEqual([
        "Search",
      ]);
      await context.close();
    });
    it("does not let page code replace the provider extraction bridge", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<input value=\"private-draft-123\"><button>Submit</button><button>Cancel</button>'; try { window.__sedum.collect = () => ({ candidates: [{name:document.querySelector('input').value}] }); } catch {} try { window.__sedum = { protocol: 1, collect: () => ({ candidates: [{name:document.querySelector('input').value}] }) }; } catch {}",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Submit",
        "Cancel",
      ]);
      await page.evaluate(
        "const live = window.__sedum.findBySignals({operation:'click'}); try { live.candidates[1].name = document.querySelector('input').value } catch {} try { live.candidates[1] = { ...live.candidates[1], name: document.querySelector('input').value } } catch {}",
      );
      const continuation = await collectCandidates(
        page,
        "click",
        1,
        found.version,
      );
      expect(continuation.candidates[0]?.name).toBe("Cancel");
      expect(JSON.stringify(projectCandidates(found))).not.toContain(
        "private-draft-123",
      );
      expect(JSON.stringify(projectCandidates(continuation))).not.toContain(
        "private-draft-123",
      );
      await context.close();
    });
    it("excludes ARIA editable values and content-visibility hidden subtrees", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<div role=\"textbox fallback\">secret-field-123</div><div style=\"content-visibility:hidden\"><p>secret-hidden</p><button>Hidden</button></div><button>Submit</button>'",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Submit",
      ]);
      expect(JSON.stringify(projectCandidates(found))).not.toContain(
        "secret-field-123",
      );
      const digest = await pageDigest(page);
      expect(digest.text).not.toContain("secret-field-123");
      expect(digest.text).not.toContain("secret-hidden");
      await context.close();
    });
    it("keeps rendered display-contents text in a complete digest", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<div style=\"display:contents\">VISIBLE_DIRECT_TEXT</div><p>Other</p>'",
      );
      const digest = await pageDigest(page);
      expect(digest.complete).toBe(true);
      expect(digest.text).toContain("VISIBLE_DIRECT_TEXT");
      expect(digest.text).toContain("Other");
      await context.close();
    });
    it("offers readable leaves without layout wrappers", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<article><h2>Camera</h2><p>In stock</p><button>Add to cart</button></article>'",
      );
      const found = await collectCandidates(page, "read");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Camera",
        "In stock",
      ]);
      await context.close();
    });
    it("keeps product names ahead of shared prices and never hits a replacement card", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<article><span>$10</span><span>USD</span><h2>Camera</h2><div><button>Add to cart</button></div></article><article><span>$10</span><span>USD</span><h2>Phone</h2><div><button>Add to cart</button></div></article>'",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates[0]?.peers[0]).toContain("Camera");
      expect(found.candidates[1]?.peers[0]).toContain("Phone");
      const key = new Uint8Array(32).fill(6);
      const entry = stageEntry(
        key,
        (await pageVersion(page)).route,
        "click",
        "Buy Camera",
        found.candidates[0]!,
        found,
      );
      await page.evaluate("document.querySelector('article').remove()");
      expect(
        await matchLiveEntry(page, entry, key, "click", "Buy Camera"),
      ).toEqual({ hit: false, reason: "strong_signal_conflict" });
      await context.close();
    });
    it("rejects opacity-hidden content and refs stale before aiming", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<div style=\"opacity:0\"><button>Hidden</button><p>hidden-token-123</p></div><article><h2>Camera</h2><button onclick=\"window.clicked=1\">Buy</button></article>'",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Buy",
      ]);
      expect((await pageDigest(page)).text).not.toContain("hidden-token-123");
      await page.evaluate("document.querySelector('h2').textContent='Phone'");
      expect(await clickTarget(page, found.candidates[0]!.ref)).toEqual({
        actionable: false,
        reason: "stale",
      });
      expect(await page.evaluate("window.clicked || 0")).toBe(0);
      await context.close();
    });
    it("lets the browser complete a click when pointerdown mutates the same control", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button>Buy</button>'; document.querySelector('button').addEventListener('pointerdown', function () { window.pointerCount=(window.pointerCount||0)+1; this.textContent='Changed'; }); document.querySelector('button').addEventListener('click', () => window.clickCount=(window.clickCount||0)+1)",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate("window.pointerCount || 0")).toBe(1);
      expect(await page.evaluate("window.clickCount || 0")).toBe(1);
      await context.close();
    });
    it("refuses a target changed while Playwright waits for stability", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button>Buy</button>'",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      await page.evaluate(
        "const button=document.querySelector('button'); button.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(80px)' }], { duration: 800, easing: 'linear' }); setTimeout(() => { button.textContent='Delete all'; button.addEventListener('click', () => window.deleted=true); }, 100)",
      );
      expect(await page.clickRef(aimed.aim)).toEqual({
        actionable: false,
        reason: "stale",
      });
      expect(await page.evaluate("window.deleted === true")).toBe(false);
      expect(
        await page.evaluate("document.querySelector('button').textContent"),
      ).toBe("Delete all");
      await context.close();
    });
    it("never reports a navigation click as a retryable miss", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/navigated\">Go</a>'",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(page.url).toContain("/navigated");
      await context.close();
    });
    it("uses the browser destination when page code changes href during the click", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/original\">Go</a>'; window.addEventListener('click', (event) => { document.querySelector('a').href='/updated'; event.stopPropagation(); }, true)",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(page.url).toContain("/updated");
      await context.close();
    });
    it("preserves a page-canceled link click without replaying its href", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/delete\">Open menu</a>'; document.querySelector('a').addEventListener('click', (event) => { event.preventDefault(); window.menuOpened=true; })",
      );
      const route = page.url;
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate("window.menuOpened === true")).toBe(true);
      expect(page.url).toBe(route);
      await context.close();
    });
    it("does not navigate a link canceled by an inline return false", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/delete\" onclick=\"window.menuOpened=true; return false\">Open menu</a>'",
      );
      const route = page.url;
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      await page.clickRef(aimed.aim);
      expect(await page.evaluate("window.menuOpened === true")).toBe(true);
      expect(page.url).toBe(route);
      await context.close();
    });
    it("preserves a handler that checks defaultPrevented before canceling", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/danger\">Open menu</a>'; document.querySelector('a').addEventListener('click', (event) => { if (event.defaultPrevented) return; event.preventDefault(); window.menuOpened=true; })",
      );
      const route = page.url;
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate("window.menuOpened === true")).toBe(true);
      expect(page.url).toBe(route);
      await context.close();
    });
    it("honors link cancellation through the native Event method", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/danger\">Open menu</a>'; document.querySelector('a').addEventListener('click', (event) => { Event.prototype.preventDefault.call(event); window.menuOpened=true; })",
      );
      const route = page.url;
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      await page.clickRef(aimed.aim);
      expect(page.url).toBe(route);
      expect(await page.evaluate("window.menuOpened === true")).toBe(true);
      await context.close();
    });
    it("honors a previously cached native preventDefault method", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "window.cancelClick=Event.prototype.preventDefault; document.querySelector('#app').innerHTML = '<a href=\"/danger\">Open menu</a>'; document.querySelector('a').addEventListener('click', (event) => { window.cancelClick.call(event); window.menuOpened=true; })",
      );
      const route = page.url;
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(page.url).toBe(route);
      expect(await page.evaluate("window.menuOpened === true")).toBe(true);
      await context.close();
    });
    it("uses document navigation so link referrer policy is preserved", async () => {
      const { page, context } = await fresh();
      lastReferer = undefined;
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<a href=\"/referer-check\">Go</a>'",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      await page.clickRef(aimed.aim);
      expect(page.url).toContain("/referer-check");
      expect(lastReferer).toBe(`${base}/`);
      await context.close();
    });
    it("refuses link modes outside the single-page driver contract", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        'document.querySelector(\'#app\').innerHTML = \'<a href="/other" target="_blank">New tab</a><a href="/file" download>Download</a>\'',
      );
      const found = await collectCandidates(page, "click");
      for (const candidate of found.candidates)
        expect(await clickTarget(page, candidate.ref)).toEqual({
          actionable: false,
          reason: "not_actionable",
        });
      await context.close();
    });
    it("does not collect a nested control inside a new-tab or download link", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        'document.querySelector(\'#app\').innerHTML = \'<a href="/other" target="_blank"><span role="button">New tab</span></a><a href="/file" download><span role="button">Download</span></a>\'',
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.tag)).toEqual([
        "a",
        "a",
      ]);
      for (const candidate of found.candidates)
        expect(await clickTarget(page, candidate.ref)).toEqual({
          actionable: false,
          reason: "not_actionable",
        });
      await context.close();
    });
    it("uses a plain div product title to veto a replacement", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<article><div>Price: $10</div><div>In stock</div><div>Camera</div><div><button onclick=\"window.clicked=(window.clicked||0)+1\">Add to cart</button></div></article><article><div>Price: $10</div><div>In stock</div><div>Phone</div><div><button onclick=\"window.clicked=(window.clicked||0)+1\">Add to cart</button></div></article>'",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates[0]?.peers[0]).toContain("Camera");
      expect(found.candidates[1]?.peers[0]).toContain("Phone");
      const key = new Uint8Array(32).fill(5);
      const entry = stageEntry(
        key,
        (await pageVersion(page)).route,
        "click",
        "Buy Camera",
        found.candidates[0]!,
        found,
      );
      await page.evaluate("document.querySelector('article').remove()");
      expect(
        await matchLiveEntry(page, entry, key, "click", "Buy Camera"),
      ).toEqual({ hit: false, reason: "strong_signal_conflict" });
      expect(await page.evaluate("window.clicked || 0")).toBe(0);
      await context.close();
    });
    it("refuses a shared hook when the bounded item context is incomplete", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<article><div>Camera</div><div>' + 'x'.repeat(30) + '</div><div>' + 'y'.repeat(30) + '</div><div>' + 'z'.repeat(30) + '</div><div>In stock</div><button data-testid=\"shared-cart\">Add to cart</button></article>'",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates[0]?.signals.hook).toBe("shared-cart");
      expect(found.candidates[0]?.signals.contextComplete).toBe(false);
      const key = new Uint8Array(32).fill(11);
      expect(() =>
        stageEntry(
          key,
          page.url,
          "click",
          "Buy Camera",
          found.candidates[0]!,
          found,
        ),
      ).toThrow("candidate_not_distinguishable");
      await context.close();
    });
    it("canonicalizes arbitrary page-authored roles before provider or cache metadata", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button role=\"token=SECRET\" data-testid=\"safe-hook\">Buy</button>'",
      );
      const found = await collectCandidates(page, "click");
      expect(found.candidates[0]?.role).toBe("button");
      expect(JSON.stringify(projectCandidates(found))).not.toContain("SECRET");
      const key = new Uint8Array(32).fill(8);
      expect(() =>
        stageEntry(key, page.url, "click", "Buy", found.candidates[0]!, found),
      ).toThrow("candidate_not_distinguishable");
      await context.close();
    });
    it("lets Playwright complete a native click after a hover side effect", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button>Buy</button>'; document.querySelector('button').addEventListener('pointerover', function () { window.hoverCount=(window.hoverCount||0)+1; this.textContent='Changed'; }); document.querySelector('button').addEventListener('click', () => window.clickCount=(window.clickCount||0)+1)",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(
        await page.evaluate<number>("window.hoverCount || 0"),
      ).toBeGreaterThan(0);
      expect(await page.evaluate("window.clickCount || 0")).toBe(1);
      await context.close();
    });
    it("lets the browser complete a click after a capture side effect", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button>Buy</button>'; window.addEventListener('pointerdown', () => { window.captureCount=(window.captureCount||0)+1; document.querySelector('button').textContent='Changed'; }, true); document.querySelector('button').addEventListener('click', () => window.clickCount=(window.clickCount||0)+1)",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate("window.captureCount || 0")).toBe(1);
      expect(await page.evaluate("window.clickCount || 0")).toBe(1);
      await context.close();
    });
    it("does not second-guess a native click when the control removes itself", async () => {
      const { page, context } = await fresh();
      await page.evaluate(
        "document.querySelector('#app').innerHTML = '<button>Buy</button>'; document.querySelector('button').addEventListener('pointerdown', function () { window.pointerCount=(window.pointerCount||0)+1; this.remove(); })",
      );
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("No aim");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate("window.pointerCount || 0")).toBe(1);
      expect(
        await page.evaluate("document.querySelector('button') === null"),
      ).toBe(true);
      await context.close();
    });
  },
);
