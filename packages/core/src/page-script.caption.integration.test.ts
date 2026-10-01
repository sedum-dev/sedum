import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "./browser-driver.js";
import { collectCandidates } from "./page-bridge.js";

// Captions beside or above fields with no <label>, only an example value.
const FORM = `
<form>
  <div>Postal code</div>
  <div><input placeholder="AB0A 0AA"></div>
  <div style="display:flex;gap:8px"><span>Outstanding balance</span><input placeholder="E.g. 10,000"></div>
  <label>Email <input placeholder="you@example.com"></label>
  <input aria-label="Search" placeholder="Type to search">
  <div style="display:flex;gap:8px"><span>Reference</span><input aria-label="" placeholder="E.g. ref"></div>
  <div style="display:flex;gap:8px"><span>Account number</span><input aria-labelledby="missing" placeholder="E.g. 123"></div>
  <section><p>Account details</p><div style="height:60px"></div><div style="display:flex;gap:8px"><div><div><div><input placeholder="E.g. 5"></div></div></div><span>Monthly payment</span></div></section>
</form>
<section><p>Unrelated heading text</p><div style="height:700px"></div><input placeholder="E.g. 4.5"></section>`;

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "fields named by an example value",
  () => {
    let server: Server;
    let base = "";
    let session: BrowserSession;
    beforeAll(async () => {
      server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<!doctype html><html><body>${FORM}</body></html>`);
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

    it("hints the caption a person reads beside or above the field", async () => {
      const context = await session.newContext({
        viewport: { width: 700, height: 1200 },
      });
      const page = await context.newPage();
      await page.goto(base);
      const found = await collectCandidates(page, "fill");
      const hints = Object.fromEntries(
        found.candidates.map((c) => [c.name, c.signals.nameHint ?? ""]),
      );
      expect(hints["AB0A 0AA"]).toBe('label "Postal code"');
      expect(hints["E.g. 10,000"]).toBe('label "Outstanding balance"');
      expect(hints["E.g. ref"]).toBe('label "Reference"');
      expect(hints["E.g. 123"]).toBe('label "Account number"');
      // Prefer the close caption on the right over a farther heading above.
      expect(hints["E.g. 5"]).toBe('label "Monthly payment"');
      // A labelled field keeps its label as the name and gets no caption.
      expect(hints["Email"]).not.toContain("label");
      expect(hints["Search"]).not.toContain("label");
      // Text far above the field is not its caption, and the name stays the
      // placeholder either way.
      expect(hints["E.g. 4.5"]).toBe("");
      expect(found.candidates.map((c) => c.name)).toContain("AB0A 0AA");
      await context.close();
    });
  },
);
