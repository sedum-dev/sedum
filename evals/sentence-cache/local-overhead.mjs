// Time cache admission and matching alone, with no browser, model or network.
//
//   node evals/sentence-cache/local-overhead.mjs name=<built checkout> [...]
//
// Candidate sets are synthetic product grids shaped like the scanner's output
// for repeated "Add to cart" buttons with bounded item context.
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";

const key = new Uint8Array(32).fill(5);
const route = "https://fixture.test/inventory.html";
const description =
  "A long product description that the candidate scanner bounded to its limit";

/** Sentence clues are words of letters, so titles differ by letters, not digits. */
function title(index) {
  let letters = "";
  for (let n = index + 26; n > 0; n = Math.floor(n / 26))
    letters = String.fromCharCode(97 + (n % 26)) + letters;
  return `Sauce Labs Pack${letters}`;
}

function grid(size) {
  const products = Array.from({ length: size }, (_, index) => ({
    ref: `p${index}`,
    tag: "button",
    role: "button",
    name: "Add to cart",
    peers: [title(index), description],
    editable: false,
    disabled: false,
    inputType: "",
    signals: {
      id: `add-to-cart-${index}`,
      path: `body:0/div:${index}/button:0`,
      contextComplete: false,
    },
  }));
  const checkout = {
    ...products[0],
    ref: "checkout",
    name: "Checkout",
    peers: [],
    signals: { id: "checkout", path: "body:0/button:9" },
  };
  return [...products, checkout];
}

function page(candidates) {
  return {
    protocol: 1,
    version: { document: "d", route, revision: 0 },
    total: candidates.length,
    offset: 0,
    next: null,
    complete: true,
    candidates,
  };
}

function time(fn, iterations) {
  for (let i = 0; i < 50; i++) fn();
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return ((performance.now() - started) / iterations) * 1000;
}

const cases = [
  [
    "repeated button",
    (size) => `click Add to cart for ${title(size >> 1)}`,
    (all, size) => all[size >> 1],
  ],
  ["unique control", () => "click the Checkout button", (all) => all.at(-1)],
];
const rows = [];
for (const spec of process.argv.slice(2)) {
  const [name, dir] = spec.split("=");
  const core = await import(
    pathToFileURL(path.join(path.resolve(dir), "packages/core/dist/index.js"))
      .href
  );
  for (const size of [6, 50, 200]) {
    const all = grid(size);
    for (const [label, sentenceFor, targetFor] of cases) {
      const sentence = sentenceFor(size);
      const target = targetFor(all, size);
      let entry;
      try {
        entry = core.stageEntry(
          key,
          route,
          "click",
          sentence,
          target,
          page(all),
        );
      } catch {
        entry = undefined;
      }
      const stageUs = time(() => {
        try {
          core.stageEntry(key, route, "click", sentence, target, page(all));
        } catch {
          /* Refusals cost time too; measure them the same way. */
        }
      }, 500);
      const matchUs = entry
        ? time(
            () =>
              core.matchEntry(entry, key, route, "click", sentence, all, true),
            500,
          )
        : null;
      rows.push({
        variant: name,
        candidates: all.length,
        case: label,
        admitted: !!entry,
        stageUs: Math.round(stageUs),
        matchUs: matchUs === null ? null : Math.round(matchUs),
      });
    }
  }
}
console.table(rows);
