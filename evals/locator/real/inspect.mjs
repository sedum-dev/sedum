import { setTimeout } from "node:timers";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import console from "node:console";
import {
  PlaywrightBrowserDriver,
  collectCandidates,
  quietPage,
} from "../../../packages/core/dist/index.js";
import { VIEWPORT, storeDir } from "./lib/browser.mjs";
import { INVENTORY } from "./lib/inventory.mjs";
import { serveStore } from "./lib/serve.mjs";

const realRoot = dirname(fileURLToPath(import.meta.url));
const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    screens: { type: "string", default: "3" },
    all: { type: "boolean", default: false },
  },
});
const store = storeDir(realRoot);
const ids = args.all
  ? readdirSync(store).filter((id) =>
      existsSync(join(store, id, "snapshot.html.gz")),
    )
  : positionals;
if (!ids.length) throw new Error("Name one or more site ids, or pass --all.");
const screens = Number(args.screens);

/** Tag what Sedum's extractor currently offers for click and fill. */
async function markSedum(page) {
  for (const operation of ["click", "fill"]) {
    await collectCandidates(page, operation).catch(() => undefined);
    await page.evaluate(`(() => {
      for (const el of document.querySelectorAll("[data-sedum-ref]"))
        el.setAttribute("data-inspect-${operation}", "");
    })()`);
  }
}

const OVERLAY = (items) => `(() => {
  const layer = document.createElement("div");
  layer.id = "sedum-inspect-overlay";
  layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
  for (const item of ${JSON.stringify(items)}) {
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;border:1.5px solid " + (item.sedum ? "#1c5cab" : "#d03b3b") + ";left:" + item.box.x + "px;top:" + item.box.y + "px;width:" + item.box.w + "px;height:" + item.box.h + "px";
    const tag = document.createElement("span");
    tag.textContent = item.n;
    tag.style.cssText = "position:absolute;left:-1px;top:-14px;font:600 10px/13px monospace;padding:0 3px;color:#fff;background:" + (item.sedum ? "#1c5cab" : "#d03b3b");
    box.append(tag);
    layer.append(box);
  }
  document.body.append(layer);
})()`;

const { server, base } = await serveStore(store);
const session = await new PlaywrightBrowserDriver().launch({
  browser: "chromium",
});
try {
  for (const id of ids) {
    if (!existsSync(join(store, id, "snapshot.html.gz"))) {
      console.log(`${id}: no snapshot; run capture first`);
      continue;
    }
    const context = await session.newContext({
      viewport: VIEWPORT,
      locale: "en-US",
    });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/real/${id}/snapshot.html`, {
        timeoutMs: 20_000,
      });
      await quietPage(page, 300, 5_000);
      await markSedum(page);
      const items = await page.evaluate(INVENTORY);
      writeFileSync(
        join(store, id, "inventory.json"),
        JSON.stringify(items, null, 1) + "\n",
      );
      const lines = items.map(
        (i) =>
          `${String(i.n).padStart(4)} ${(i.sedum || "-").padEnd(5)} y=${String(i.box.y).padStart(5)} ${i.tag}${i.role ? `[${i.role}]` : ""}${i.type ? `(${i.type})` : ""}${i.shadow ? " {shadow}" : ""} ` +
          JSON.stringify(
            i.label || i.text || i.placeholder || i.title || "",
          ).slice(0, 90) +
          `  ${i.selector}`,
      );
      writeFileSync(join(store, id, "inventory.txt"), lines.join("\n") + "\n");
      // Numbered screenshots of the first screens: blue = Sedum sees it, red = it does not.
      const height = await page.evaluate(
        "document.documentElement.scrollHeight",
      );
      const visible = items.filter((i) => i.box.y < screens * VIEWPORT.height);
      await page.evaluate(OVERLAY(visible));
      for (let s = 0; s < screens && s * VIEWPORT.height < height; s++) {
        await page.evaluate(`window.scrollTo(0, ${s * VIEWPORT.height})`);
        await new Promise((r) => setTimeout(r, 150));
        const shot = await page.captureFrame();
        writeFileSync(join(store, id, `inspect-${s + 1}.png`), shot);
      }
      const seen = items.filter((i) => i.sedum).length;
      console.log(
        `${id.padEnd(28)} ${String(items.length).padStart(5)} controls, ${String(seen).padStart(5)} offered by Sedum`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await session.close();
  server.close();
}
