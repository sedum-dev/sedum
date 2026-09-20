import { createServer, type Server } from "node:http";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";

const browserIntegration = process.env.SEDUM_BROWSER_INTEGRATION === "1";

describe.skipIf(!browserIntegration)("Playwright browser integration", () => {
  let server: Server;
  let baseUrl = "";

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><title>Fixture</title><main>fixture page</main>",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Fixture server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("opens, navigates, reads, and isolates contexts", async () => {
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const firstContext = await session.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const firstPage = await firstContext.newPage();
    await firstPage.goto(baseUrl);
    expect(await firstPage.text()).toContain("fixture page");
    await firstPage.evaluate(
      "document.cookie = 'sedum=first'; document.cookie",
    );

    const secondContext = await session.newContext();
    const secondPage = await secondContext.newPage();
    await secondPage.goto(baseUrl);
    expect(await secondPage.evaluate<string>("document.cookie")).toBe("");

    await firstContext.close();
    await secondContext.close();
    await session.close();
  });
});
