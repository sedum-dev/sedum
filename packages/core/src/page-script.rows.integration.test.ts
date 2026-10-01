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
