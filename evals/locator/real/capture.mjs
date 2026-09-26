import { Buffer } from "node:buffer";
import { setTimeout } from "node:timers";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import console from "node:console";
import process from "node:process";
import {
  USER_AGENT,
  VIEWPORT,
  launchLive,
  launchOffline,
  storeDir,
} from "./lib/browser.mjs";
import { FREEZE, adoptionScript, stripUrls } from "./lib/freeze.mjs";
import { serveStore } from "./lib/serve.mjs";

const realRoot = dirname(fileURLToPath(import.meta.url));
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  },
});
const sites = JSON.parse(readFileSync(join(realRoot, "sites.json"), "utf8"));
const store = storeDir(realRoot);
const wanted = args.all
  ? sites
  : sites.filter((site) => positionals.includes(site.id));
if (!wanted.length)
  throw new Error("Name site ids from sites.json, or pass --all.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function settle(page, ms = 800, limit = 8000) {
  const deadline = Date.now() + limit;
  let last = -1;
  while (Date.now() < deadline) {
    const count = await page.evaluate(
      "document.getElementsByTagName('*').length",
    );
    if (count === last) return;
    last = count;
    await sleep(ms);
  }
}

async function capture(browser, site) {
  const dir = join(store, site.id);
  mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: site.locale ?? "en-US",
    userAgent: USER_AGENT,
  });
  try {
    const page = await context.newPage();
    const response = await page.goto(site.url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const status = response?.status() ?? 0;
    await page
      .waitForLoadState("load", { timeout: 20_000 })
      .catch(() => undefined);
    await settle(page);
    for (const action of site.actions ?? []) {
      if (action.click)
        await page
          .click(action.click, { timeout: 5_000 })
          .catch(() => undefined);
      await settle(page);
    }
    // Scroll through the page so lazy content renders, then return to top.
    if (site.scroll !== false) {
      for (let i = 0; i < 8; i++) {
        await page.mouse.wheel(0, VIEWPORT.height);
        await sleep(350);
      }
      await page.evaluate("window.scrollTo(0, 0)");
      await settle(page);
    }
    await page.screenshot({ path: join(dir, "live.png") });
    const title = await page.title();
    const frozen = await page.evaluate(FREEZE);
    let html = frozen.html;
    for (const { id, href } of frozen.pending) {
      let css = "";
      try {
        const reply = await context.request.get(href, { timeout: 15_000 });
        if (reply.ok()) css = await reply.text();
      } catch {
        css = "";
      }
      html = html.replace(
        `data-freeze-fetch="${id}">`,
        `data-freeze-fetch="${id}">${css.replace(/<\/style/gi, "<\\/style")}`,
      );
    }
    const sheets = Object.fromEntries(
      Object.entries(frozen.sheets).map(([key, css]) => [key, stripUrls(css)]),
    );
    html = stripUrls(html);
    const at = html.lastIndexOf("</body>");
    const script = adoptionScript(sheets);
    html =
      at >= 0 ? html.slice(0, at) + script + html.slice(at) : html + script;
    const body = Buffer.from(html, "utf8");
    writeFileSync(join(dir, "snapshot.html.gz"), gzipSync(body, { level: 9 }));
    const meta = {
      id: site.id,
      url: site.url,
      finalUrl: page.url(),
      status,
      title,
      capturedAt: new Date().toISOString(),
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      shadowRoots: frozen.shadowRoots,
      unfetchedStylesheets: frozen.pending.length,
    };
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    return meta;
  } finally {
    await context.close();
  }
}

/** Render the frozen snapshot offline, for comparison with live.png. */
async function renderFrozen(browser, base, site) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/real/${site.id}/snapshot.html`, {
      timeout: 20_000,
    });
    await sleep(500);
    await page.screenshot({ path: join(store, site.id, "frozen.png") });
    return await page.evaluate(
      "document.querySelectorAll('a,button,input,select,textarea,[role]').length",
    );
  } finally {
    await context.close();
  }
}

const live = await launchLive();
const offline = await launchOffline();
const { server, base } = await serveStore(store);
let failures = 0;
try {
  for (const site of wanted) {
    try {
      const meta = await capture(live, site);
      const controls = await renderFrozen(offline, base, site);
      console.log(
        `${site.id.padEnd(28)} ${meta.status} ${(meta.bytes / 1024).toFixed(0).padStart(6)} KB  ${String(controls).padStart(5)} controls  shadow ${meta.shadowRoots}  ${meta.title.slice(0, 50)}`,
      );
    } catch (error) {
      failures++;
      console.log(
        `${site.id.padEnd(28)} FAILED ${String(error.message).split("\n")[0]}`,
      );
    }
  }
} finally {
  await live.close();
  await offline.close();
  server.close();
}
process.exitCode = failures ? 1 : 0;
