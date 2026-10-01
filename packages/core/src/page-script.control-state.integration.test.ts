import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PlaywrightBrowserDriver,
  type BrowserSession,
} from "./browser-driver.js";
import { collectCandidates, controlState } from "./page-bridge.js";

const FORM = `
<input aria-label="Email" value="ada@example.com" readonly>
<input aria-label="Password" type="password" value="hunter2">
<input aria-label="Search" autofocus>
<label><input type="checkbox" checked> Select all</label>
<div role="button" aria-disabled="true">Save debt</div>`;

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "control state",
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

    it("reads value, focus, checked and disabled state, never a password", async () => {
      const context = await session.newContext({
        viewport: { width: 700, height: 500 },
      });
      const page = await context.newPage();
      await page.goto(base);
      const click = await collectCandidates(page, "click");
      const state = async (name: string) => {
        const candidate = click.candidates.find((c) => c.name === name)!;
        return controlState(page, {
          ref: candidate.ref,
          version: click.version,
          tag: candidate.tag,
          name: candidate.name,
        });
      };
      expect(await state("Email")).toMatchObject({
        status: "ok",
        value: "ada@example.com",
      });
      expect(await state("Select all")).toMatchObject({ checked: true });
      expect(await state("Save debt")).toMatchObject({ disabled: true });
      const fill = await collectCandidates(page, "fill");
      const read = async (name: string) => {
        const candidate = fill.candidates.find((c) => c.name === name)!;
        return controlState(page, {
          ref: candidate.ref,
          version: fill.version,
          tag: candidate.tag,
          name: candidate.name,
        });
      };
      expect(await read("Search")).toMatchObject({ focused: true, value: "" });
      expect(await read("Password")).toMatchObject({ value: null });
      await context.close();
    });
  },
);
