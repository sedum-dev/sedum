/* global console, document, window */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
console.log("CHROMIUM_VERSION", browser.version());

try {
  await page.setContent(`
    <main>
      <section aria-label="Products">
        <article><h2>Amber mug</h2><p>$12</p><button>Add to cart</button></article>
        <article><h2>Blue mug</h2><p>$12</p><button>Add to cart</button></article>
      </section>
      <p>Visible plain text</p>
      <p hidden>Hidden secret</p>
      <label>Coupon <input value="editable secret" placeholder="Enter coupon"></label>
      <a href="/details?token=secret">Details</a>
      <dialog open aria-label="Cart"><p>Cart is empty</p></dialog>
    </main>
  `);
  const snapshot = await page.ariaSnapshotJSON({ mode: "default" });
  console.log("SNAPSHOT_TYPE", typeof snapshot);
  console.log("SNAPSHOT", JSON.stringify(snapshot));
  const snapshotText = JSON.stringify(snapshot);
  assert.ok(snapshotText.includes('"name":"Amber mug"'));
  assert.ok(snapshotText.includes('"name":"Blue mug"'));
  assert.ok(snapshotText.includes('"text":"Visible plain text"'));
  assert.ok(snapshotText.includes('"role":"dialog"'));
  assert.ok(snapshotText.includes('"text":"editable secret"'));
  assert.ok(snapshotText.includes('"url":"/details?token=secret"'));
  assert.ok(!snapshotText.includes("Hidden secret"));
  const scopedMatches = await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Amber mug" }) })
    .getByRole("button", { name: "Add to cart" })
    .count();
  console.log("AMBER_SCOPED_MATCHES", scopedMatches);
  assert.equal(scopedMatches, 1);

  await page.setContent(`
    <button id="target" aria-label="Buy amber mug">Buy</button>
    <script>
      window.clicks = [];
      const target = document.querySelector('#target');
      target.addEventListener('pointerenter', () => {
        target.setAttribute('aria-label', 'Buy blue mug');
      });
      target.addEventListener('click', event => {
        window.clicks.push(event.currentTarget.getAttribute('aria-label'));
      });
    </script>
  `);
  const hoverTarget = await page
    .getByRole("button", { name: "Buy amber mug" })
    .elementHandle();
  if (!hoverTarget) throw new Error("Hover target handle not found");
  const beforeHoverClick = await hoverTarget.getAttribute("aria-label");
  const freshSnapshot = await page.ariaSnapshotJSON({ mode: "default" });
  assert.ok(JSON.stringify(freshSnapshot).includes('"name":"Buy amber mug"'));
  const receiverIsTarget = await hoverTarget.evaluate(
    (element) =>
      document.elementFromPoint(
        element.getBoundingClientRect().x +
          element.getBoundingClientRect().width / 2,
        element.getBoundingClientRect().y +
          element.getBoundingClientRect().height / 2,
      ) === element,
  );
  assert.equal(receiverIsTarget, true);
  console.log("BEFORE_HOVER_CLICK", beforeHoverClick);
  await hoverTarget.click({ timeout: 3000 });
  const hoverClicks = await page.evaluate(() => window.clicks);
  console.log("AFTER_HOVER_CLICK", hoverClicks);
  assert.equal(beforeHoverClick, "Buy amber mug");
  assert.deepEqual(hoverClicks, ["Buy blue mug"]);
  console.log(
    "NO_GO",
    "native click dispatched after the pinned target changed meaning",
  );
} finally {
  await browser.close();
}
