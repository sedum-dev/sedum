import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";

/**
 * SED-79 spike: exercise Playwright itself, without Sedum's page script or
 * clickRef guard. These tests measure what the browser primitive gives us and
 * where a Sedum-specific safety layer is still needed.
 */
describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "Playwright-native click and snapshot spike",
  () => {
    let server: Server;
    let browser: Browser;
    let base = "";
    let lastReferer: string | undefined;

    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url === "/destination")
          lastReferer = request.headers.referer;
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<!doctype html><html><body></body></html>");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture port");
      base = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch();
    });

    afterAll(async () => {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("honors native and cached preventDefault without replaying a link", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          const cancel = Event.prototype.preventDefault;
          document.body.innerHTML = '<a href="/danger">Open menu</a>';
          document.querySelector("a")!.addEventListener("click", (event) => {
            cancel.call(event);
            (window as Window & { menuOpened?: boolean }).menuOpened = true;
          });
        });
        await page.getByRole("link", { name: "Open menu" }).click();
        expect(page.url()).toBe(`${base}/`);
        expect(
          await page.evaluate(
            () => (window as Window & { menuOpened?: boolean }).menuOpened,
          ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it("preserves defaultPrevented checks and inline return false", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML = '<a href="/danger">Open menu</a>';
          document.querySelector("a")!.addEventListener("click", (event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            (window as Window & { menuOpened?: boolean }).menuOpened = true;
          });
        });
        await page.getByRole("link", { name: "Open menu" }).click();
        expect(page.url()).toBe(`${base}/`);
        expect(
          await page.evaluate(
            () => (window as Window & { menuOpened?: boolean }).menuOpened,
          ),
        ).toBe(true);
        await page.evaluate(() => {
          document.body.innerHTML =
            '<a href="/danger" onclick="window.inlineOpened=true; return false">Inline menu</a>';
        });
        await page.getByRole("link", { name: "Inline menu" }).click();
        expect(page.url()).toBe(`${base}/`);
        expect(
          await page.evaluate(
            () => (window as Window & { inlineOpened?: boolean }).inlineOpened,
          ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });

    it("lets ordinary links navigate with the browser referrer", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML = '<a href="/destination">Go</a>';
        });
        lastReferer = undefined;
        await page.getByRole("link", { name: "Go" }).click();
        expect(page.url()).toBe(`${base}/destination`);
        expect(lastReferer).toBe(`${base}/`);
      } finally {
        await context.close();
      }
    });

    it("exposes the changed-href gap in a bare native click", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML = '<a href="/safe">Go</a>';
          window.addEventListener(
            "click",
            () => {
              document.querySelector("a")!.href = "/wrong";
            },
            true,
          );
        });
        await page.getByRole("link", { name: "Go" }).click();
        // Observation, not desired Sedum behavior: native click alone cannot
        // enforce the original href after page handlers run.
        expect(page.url()).toBe(`${base}/wrong`);
      } finally {
        await context.close();
      }
    });

    it("shows that aborting an unexpected navigation still leaves the page", async () => {
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML = '<a href="/safe">Go</a>';
          window.addEventListener(
            "click",
            () => {
              document.querySelector("a")!.href = "/wrong";
            },
            true,
          );
        });
        const blocked: string[] = [];
        await page.route("**/*", async (route) => {
          const request = route.request();
          if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame() &&
            request.url() !== `${base}/safe`
          ) {
            blocked.push(request.url());
            await route.abort("blockedbyclient");
          } else {
            await route.fallback();
          }
        });
        await page
          .getByRole("link", { name: "Go" })
          .click()
          .catch(() => undefined);
        expect(blocked).toEqual([`${base}/wrong`]);
        expect(page.url()).not.toBe(`${base}/`);
        expect(await page.getByRole("link", { name: "Go" }).count()).toBe(0);
      } finally {
        await context.close();
      }
    });

    it("tests whether an HTTP 204 route can retain the current document", async () => {
      const context = await browser.newContext({ serviceWorkers: "block" });
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML = '<a href="/safe">Go</a>';
          window.addEventListener(
            "click",
            () => {
              document.querySelector("a")!.href = "/wrong";
            },
            true,
          );
        });
        const blocked: string[] = [];
        await page.route("**/*", async (route) => {
          const request = route.request();
          if (
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame() &&
            request.url() !== `${base}/safe`
          ) {
            blocked.push(request.url());
            await route.fulfill({ status: 204, body: "" });
          } else {
            await route.fallback();
          }
        });
        await page.getByRole("link", { name: "Go" }).click();
        expect(blocked).toEqual([`${base}/wrong`]);
        expect(page.url()).toBe(`${base}/`);
        expect(await page.getByRole("link", { name: "Go" }).count()).toBe(1);
      } finally {
        await context.close();
      }
    });

    it("can fail closed on a removed card with a scoped role locator", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML =
            "<article><h2>Camera</h2><button>Add to cart</button></article><article><h2>Phone</h2><button>Add to cart</button></article>";
          document.querySelectorAll("button").forEach((button) => {
            button.addEventListener("click", () => {
              (window as Window & { clicked?: string }).clicked =
                button.parentElement?.querySelector("h2")?.textContent ?? "";
            });
          });
        });
        const camera = page
          .getByRole("article")
          .filter({ hasText: "Camera" })
          .getByRole("button", { name: "Add to cart" });
        await page.evaluate(() => document.querySelector("article")!.remove());
        await expect(camera.click({ timeout: 200 })).rejects.toThrow();
        expect(
          await page.evaluate(
            () => (window as Window & { clicked?: string }).clicked,
          ),
        ).toBeUndefined();
      } finally {
        await context.close();
      }
    });

    it("exposes missing post-hover identity revalidation in a bare locator click", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML = "<button>Buy</button>";
          document
            .querySelector("button")!
            .addEventListener("pointerover", (event) => {
              (window as Window & { hoverCount?: number }).hoverCount = 1;
              (event.currentTarget as HTMLElement).textContent = "Changed";
            });
          document.querySelector("button")!.addEventListener("click", () => {
            (window as Window & { clickCount?: number }).clickCount = 1;
          });
        });
        await page.getByRole("button", { name: "Buy" }).click({ timeout: 200 });
        expect(
          await page.evaluate(
            () => (window as Window & { hoverCount?: number }).hoverCount,
          ),
        ).toBe(1);
        expect(
          await page.getByRole("button", { name: "Changed" }).count(),
        ).toBe(1);
        // Observation, not desired Sedum behavior: Playwright does not
        // re-check the original accessible name after pointerover mutates it.
        expect(
          await page.evaluate(
            () => (window as Window & { clickCount?: number }).clickCount,
          ),
        ).toBe(1);
      } finally {
        await context.close();
      }
    });

    it("returns a structured tree that still needs Sedum payload filtering", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(base);
        await page.evaluate(() => {
          document.body.innerHTML =
            '<article><h2>Camera</h2><a href="/destination">Details</a><button>Add to cart</button></article><label>Search<input value="private-fixture-value"></label>';
        });
        const snapshot = await page.ariaSnapshotJSON({ mode: "ai" });
        const serialized = JSON.stringify(snapshot);
        expect(serialized).toContain("Camera");
        expect(serialized).toContain("Add to cart");
        expect(serialized).toMatch(/"ref":"e\d+"/);
        expect(serialized).toContain("/destination");
        expect(serialized).toContain("private-fixture-value");
        // A raw snapshot is not the SED-12 provider payload: link URLs and
        // editable values must be removed by an allowlist.
      } finally {
        await context.close();
      }
    });
  },
);
