/* global console */
import process from "node:process";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [corePath, mode] = process.argv.slice(2);
const core = await import(pathToFileURL(resolve(corePath)).href);
const session = await new core.PlaywrightBrowserDriver().launch({
  browser: "chromium",
});
const context = await session.newContext();
const page = await context.newPage();
const html = Array.from(
  { length: 10 },
  (_, index) =>
    `<article><h2>Product ${index}</h2><p>$12</p><button>Add to cart</button></article>`,
).join("");
await page.goto(`data:text/html,${encodeURIComponent(html)}`);

try {
  const durations = [];
  for (let index = 0; index < 6; index++) {
    const started = performance.now();
    if (mode === "bridge") {
      await core.quietPage(page, 100, 1000);
      const candidates = await core.collectCandidates(page, "click");
      const digest = await core.pageDigest(page);
      if (!candidates.complete || !digest.complete)
        throw new Error("incomplete bridge observation");
    } else {
      const observation = await page.observe("click");
      if (!observation.complete)
        throw new Error(
          `incomplete snapshot observation: ${observation.reason}`,
        );
    }
    durations.push(Math.round(performance.now() - started));
  }
  console.log(
    JSON.stringify({ mode, coldMs: durations[0], warmMs: durations.slice(1) }),
  );
} finally {
  await session.close();
}
