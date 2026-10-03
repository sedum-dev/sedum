import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "./browser-driver.js";
import { clickTarget, collectCandidates } from "./page-bridge.js";

// A list whose rows are clickable divs, each with an actions button that a
// :hover rule reveals and a closed menu inside it.
const ROWS = `
<style>
  .row { cursor: pointer; display: flex; justify-content: space-between; width: 400px; padding: 8px; }
  .row .actions { visibility: hidden; }
  .trigger { width: 24px; height: 24px; }
  .row:hover .actions { visibility: visible; }
  .menu { display: none; }
  .trigger .open-menu { position: absolute; }
</style>
<div class="list">
  <div class="row" id="alpha"><span>Alpha report</span>
    <div class="actions"><div role="button" tabindex="0" class="trigger"><i class="fa-ellipsis"></i>
      <div class="menu"><div role="button"><i class="fa-pencil"></i>Rename</div><div role="button"><i class="fa-trash"></i>Delete</div></div>
    </div></div>
  </div>
  <div class="row" id="beta"><span>Beta report</span>
    <div class="actions"><div role="button" tabindex="0" class="trigger"><i class="fa-ellipsis"></i>
      <div class="menu"><div role="button"><i class="fa-pencil"></i>Rename</div><div role="button"><i class="fa-trash"></i>Delete</div></div>
    </div></div>
  </div>
</div>
<div class="row" id="gamma"><span>Gamma report</span>
  <div style="visibility:hidden"><div role="button" class="trigger"><i class="fa-gear"></i></div></div>
</div>
<div class="row" id="delta"><span>Delta report</span>
  <div><div role="button" tabindex="0" class="trigger"><i class="fa-ellipsis"></i>
    <div class="open-menu"><div role="button">Archive</div><div role="button">Share</div></div>
  </div></div>
</div>
<script>
  for (const trigger of document.querySelectorAll(".trigger"))
    trigger.addEventListener("click", () => {
      document.body.dataset.opened = trigger.closest(".row").id;
    });
  for (const row of document.querySelectorAll(".row"))
    row.addEventListener("click", (event) => {
      if (!event.target.closest(".trigger")) document.body.dataset.row = row.id;
    });
</script>`;

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "clickable rows and hover-revealed controls",
  () => {
    let server: Server;
    let base = "";
    let session: BrowserSession;
    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><html><body>${ROWS}</body></html>`);
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

    it("offers each row and its hover-revealed actions button, bounded to the row", async () => {
      const { page, context } = await fresh();
      const found = await collectCandidates(page, "click");
      const rows = found.candidates.filter((c) => c.tag === "div" && !c.role);
      expect(rows.map((row) => row.name)).toEqual([
        "Alpha report",
        "Beta report",
        "Gamma report",
      ]);
      // Delta's open menu shows text of its own, so those items are the
      // targets, not the row around them.
      const triggers = found.candidates
        .filter((c) => c.role === "button")
        .filter((c) => c.peers[0] !== "Delta report");
      // Named by its own icon, not the closed menu's; menu items are not
      // offered until the menu opens.
      expect(triggers.map((trigger) => trigger.name)).toEqual([
        "ellipsis",
        "ellipsis",
      ]);
      expect(triggers.map((trigger) => trigger.peers)).toEqual([
        ["Alpha report"],
        ["Beta report"],
      ]);
      expect(triggers[0]!.signals.nameHint).toContain("pencil Rename");
      await context.close();
    });

    it("offers no hidden control that no hover rule reveals", async () => {
      const { page, context } = await fresh();
      const found = await collectCandidates(page, "click");
      // Gamma's gear is hidden with no :hover rule to show it.
      expect(found.candidates.map((c) => c.name)).not.toContain("gear");
      await context.close();
    });

    it("keeps an open menu's items out of the name of the control that opened it", async () => {
      const { page, context } = await fresh();
      const found = await collectCandidates(page, "click");
      const names = found.candidates.map((c) => c.name);
      // The open menu's items are their own targets, and the trigger is
      // still named by its icon rather than "Archive Share".
      expect(names).toEqual(expect.arrayContaining(["Archive", "Share"]));
      expect(names).not.toContain("Archive Share");
      expect(
        found.candidates.find((c) => c.peers[0] === "Delta report")?.name,
      ).toBe("ellipsis");
      await context.close();
    });

    it("hovers the row before clicking a control shown only on hover", async () => {
      const { page, context } = await fresh();
      const found = await collectCandidates(page, "click");
      const trigger = found.candidates.filter((c) => c.role === "button")[1]!;
      const aimed = await clickTarget(page, trigger.ref);
      expect(aimed.actionable).toBe(true);
      if (!aimed.actionable) throw new Error("not actionable");
      expect(aimed.aim.hover).toBe(true);
      const clicked = await page.clickRef(aimed.aim);
      expect(clicked.actionable).toBe(true);
      expect(await page.evaluate<string>("document.body.dataset.opened")).toBe(
        "beta",
      );
      await context.close();
    });

    it("discovers display-none controls without hovering and reveals the exact target only when clicking", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>
          .card .action { display: none }
          .card:hover .action { display: block }
        </style>
        <article class="card">
          <h2>Quarterly report</h2>
          <button class="action">Download report</button>
          <button style="display:none">Permanently hidden</button>
        </article>\`;
        document.querySelector('.card').addEventListener('pointerover', () => window.hoverCount = (window.hoverCount || 0) + 1);
        document.querySelector('.action').addEventListener('click', () => window.clicked = true)`);

      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toContain(
        "Download report",
      );
      expect(found.candidates.map((candidate) => candidate.name)).not.toContain(
        "Permanently hidden",
      );
      expect(await page.evaluate<number>("window.hoverCount || 0")).toBe(0);

      const target = found.candidates.find(
        (candidate) => candidate.name === "Download report",
      )!;
      const aimed = await clickTarget(page, target.ref);
      expect(aimed.actionable).toBe(true);
      if (!aimed.actionable) throw new Error("not actionable");
      expect(aimed.aim.hover).toBe(true);
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate<boolean>("window.clicked === true")).toBe(
        true,
      );
      expect(
        await page.evaluate<number>("window.hoverCount || 0"),
      ).toBeGreaterThan(0);
      await context.close();
    });

    it("preserves visibility and opacity reveals and uses the innermost nested hover host", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>
          .outer .visibility-action { visibility: hidden }
          .outer:hover .visibility-action { visibility: visible }
          .outer .opacity-action { opacity: 0 }
          .outer:hover .opacity-action { opacity: 1 }
          .outer .inner .nested-action { display: none }
          .outer .inner:hover .nested-action { display: block }
        </style>
        <section class="outer">
          <button class="visibility-action">Visible on hover</button>
          <button class="opacity-action">Opaque on hover</button>
          <div class="inner"><span>Nested host</span><button class="nested-action">Nested action</button></div>
        </section>\`;
        document.querySelector('.outer').addEventListener('click', event => window.clickedClass = event.target.className)`);

      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Visible on hover",
        "Opaque on hover",
        "Nested action",
      ]);
      const nested = found.candidates.find(
        (candidate) => candidate.name === "Nested action",
      )!;
      const aimed = await clickTarget(page, nested.ref);
      if (!aimed.actionable) throw new Error("not actionable");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate<string>("window.clickedClass")).toBe(
        "nested-action",
      );
      await context.close();
    });

    it("does not expose inert hover controls and never dispatches disabled ones", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>
          .host button { display: none }
          .host:hover button { display: block }
        </style>
        <div class="host">
          <button disabled>Disabled action</button>
          <div inert><button>Inert action</button></div>
        </div>\``);

      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([
        "Disabled action",
      ]);
      expect(found.candidates[0]?.disabled).toBe(true);
      expect(await clickTarget(page, found.candidates[0]!.ref)).toEqual({
        actionable: false,
        reason: "not_actionable",
      });
      await context.close();
    });

    it("does not offer controls whose hover display loses the author cascade", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>
          .host:hover button { display: block }
          #fixture .important { display: none !important }
          #fixture .specific { display: none }
          .host:hover .late { display: block }
          .host.host .late { display: none }
        </style>
        <div id="fixture" class="host"><span>Host</span>
          <button class="important">Important hidden</button>
          <button class="specific">Specific hidden</button>
          <button class="late">Later hidden</button>
        </div>\``);

      const found = await collectCandidates(page, "click");
      expect(found.candidates.map((candidate) => candidate.name)).toEqual([]);
      await context.close();
    });

    it("does not retry after hover pointer handlers make the action uncertain", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>.host button { display:none }.host:hover button { display:block }</style>
        <div class="host"><span>Host</span><button>Remove on hover</button></div>\`;
        document.querySelector('.host').addEventListener('pointerover', () => {
          window.hoverCount = (window.hoverCount || 0) + 1;
          document.querySelector('button')?.remove();
        }, { once: true })`);
      const found = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, found.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("not actionable");

      expect(await page.clickRef(aimed.aim)).toMatchObject({
        actionable: false,
        reason: "action_started",
        retryable: false,
      });
      expect(await page.evaluate<number>("window.hoverCount || 0")).toBe(1);
      await context.close();
    });

    it("does not retry unresolved native options after hover dispatch", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>.host select { display:none }.host:hover select { display:block }</style>
        <div class="host"><span>First host</span><select aria-label="First choice"><option>Available</option></select></div>
        <div class="host"><span>Second host</span><select aria-label="Second choice"><option disabled>Blocked</option></select></div>\``);
      const found = await collectCandidates(page, "click");
      const first = found.candidates.find(
        (candidate) => candidate.name === "First choice",
      )!;
      const second = found.candidates.find(
        (candidate) => candidate.name === "Second choice",
      )!;
      const firstAim = await clickTarget(page, first.ref);
      const secondAim = await clickTarget(page, second.ref);
      if (!firstAim.actionable || !secondAim.actionable)
        throw new Error("not actionable");

      expect(
        await page.clickRef(firstAim.aim, { chooseOption: () => null }),
      ).toMatchObject({
        actionable: false,
        reason: "action_started",
        retryable: false,
      });
      expect(
        await page.clickRef(secondAim.aim, { chooseOption: () => "Blocked" }),
      ).toMatchObject({
        actionable: false,
        reason: "action_started",
        retryable: false,
      });
      await context.close();
    });

    it("rejects display-none hover targets or hosts removed after their snapshot", async () => {
      const { page, context } = await fresh();
      await page.evaluate(`document.body.innerHTML = \`
        <style>.host button { display:none }.host:hover button { display:block }</style>
        <div class="host"><span>Host</span><button>Remove me</button></div>\``);
      const found = await collectCandidates(page, "click");
      const target = found.candidates[0]!;
      await page.evaluate("document.querySelector('button').remove()");
      expect(await clickTarget(page, target.ref)).toEqual({
        actionable: false,
        reason: "stale",
      });

      await page.evaluate(`document.body.innerHTML = \`
        <style>.host button { display:none }.host:hover button { display:block }</style>
        <div class="host"><span>Host</span><button>Remove host</button></div>\``);
      const next = await collectCandidates(page, "click");
      const aimed = await clickTarget(page, next.candidates[0]!.ref);
      if (!aimed.actionable) throw new Error("not actionable");
      await page.evaluate("document.querySelector('.host').remove()");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(false);
      await context.close();
    });

    it("clicks a row itself", async () => {
      const { page, context } = await fresh();
      const found = await collectCandidates(page, "click");
      const row = found.candidates.find((c) => c.name === "Alpha report")!;
      const aimed = await clickTarget(page, row.ref);
      if (!aimed.actionable) throw new Error("not actionable");
      expect((await page.clickRef(aimed.aim)).actionable).toBe(true);
      expect(await page.evaluate<string>("document.body.dataset.row")).toBe(
        "alpha",
      );
      await context.close();
    });
  },
);
