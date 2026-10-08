import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import type { CacheStore } from "./cache-store.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import type { CacheEntry } from "./page-cache.js";
import type { ProviderCall, Resolver, ResolverCandidates } from "./provider.js";
import { RunRecorder } from "./run-recorder.js";

const call: ProviderCall = {
  requestedModel: "recorded",
  model: "recorded",
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 2 },
  rate: null,
  successfulResponseCostUsd: 0.002,
  totalCostUsd: 0.002,
};
const LONG =
  "carry.allTheThings() with the sleek, streamlined pack that melds uncompromising style with unequaled laptop and tablet protection.";

interface Card {
  readonly id?: string;
  readonly title: string;
  readonly item: string;
  readonly disabled?: boolean;
}

function card(card: Card, long: boolean): string {
  return (
    `<div class="inventory_item"><div class="inventory_item_name">${card.title}</div>` +
    (long ? `<div class="inventory_item_desc">${LONG}</div>` : "") +
    `<div class="inventory_item_price">$29.99</div>` +
    `<button ${card.id ? `id="${card.id}"` : ""} ${card.disabled ? "disabled" : ""} ` +
    `onclick="location.href='/done?item=${card.item}'">Add to cart</button></div>`
  );
}

function persistedStore(seed: number) {
  const files = new Map<string, string>();
  const store: CacheStore = {
    key: new Uint8Array(32).fill(seed),
    lookup: async (digest) =>
      files.has(digest)
        ? { entry: JSON.parse(files.get(digest)!) as CacheEntry }
        : { reason: "absent" },
    put: vi.fn(async (digest: string, entry: CacheEntry) => {
      files.set(digest, JSON.stringify(entry));
    }),
    invalidate: vi.fn(async (digest: string) => {
      files.delete(digest);
    }),
    clear: async () => files.clear(),
  };
  const entries = () =>
    [...files.values()].map((text) => JSON.parse(text) as CacheEntry);
  return { store, entries };
}

/** Recorded resolver: the first offered button whose card names the title. */
const chooseTitle = (title: string) =>
  vi.fn(async (_sentence: string, offered: ResolverCandidates) => {
    const options = offered.options.filter(
      (option) => option.kind === "candidate",
    );
    const found = options.find((option) =>
      option.candidate.peers.some((peer) => peer === title),
    );
    if (!found)
      throw new Error(
        `No ${title}: ${JSON.stringify(options.map((option) => option.candidate.peers))}`,
      );
    const selected = found.candidate.id;
    const rest = 0.1 / options.length;
    return {
      selection: { kind: "candidate" as const, id: selected },
      probabilities: Object.fromEntries([
        ...options.map((option) => [
          option.candidate.id,
          option.candidate.id === selected ? 0.9 : rest,
        ]),
        ["none", rest],
      ]),
      confidence: null,
      call,
    };
  });

const backpack: Card = {
  id: "add-to-cart-sauce-labs-backpack",
  title: "Sauce Labs Backpack",
  item: "backpack",
};
const onesie: Card = {
  id: "add-to-cart-sauce-labs-onesie",
  title: "Sauce Labs Onesie",
  item: "onesie",
};
const light: Card = {
  id: "add-to-cart-sauce-labs-bike-light",
  title: "Sauce Labs Bike Light",
  item: "light",
};
const SENTENCE = "click Add to cart for Sauce Labs Backpack";

type Row = readonly [id: string, name: string, item: string];
/** Other repeated-control layouts: rows, settings sections, and a dialog over a list. */
const STRUCTURES: Record<
  "rows" | "settings" | "dialog",
  {
    readonly sentence: string;
    readonly row: (...row: Row) => string;
    readonly wrap: (rows: string) => string;
    readonly items: readonly Row[];
  }
> = {
  rows: {
    sentence: "click Edit for Ada Lovelace",
    row: (id, name, item) =>
      `<div role="row" class="member"><span role="cell" class="name">${name}</span><span role="cell">${LONG}</span>` +
      `<span role="cell"><button id="${id}" onclick="location.href='/done?item=${item}'">Edit</button></span></div>`,
    wrap: (rows) =>
      `<div role="table"><div role="rowgroup">${rows}</div></div>`,
    items: [
      ["edit-grace", "Grace Hopper", "grace"],
      ["edit-ada", "Ada Lovelace", "ada"],
      ["edit-alan", "Alan Turing", "alan"],
    ],
  },
  settings: {
    sentence: "click Manage for Email digests",
    row: (id, name, item) =>
      `<li class="setting"><span class="label">${name}</span><p>${LONG}</p>` +
      `<button id="${id}" onclick="location.href='/done?item=${item}'">Manage</button></li>`,
    wrap: (rows) =>
      `<section><h3>Notifications</h3><ul>${rows}</ul></section>` +
      `<section><h3>Security</h3><ul><li class="setting"><span class="label">Two-factor login</span><p>${LONG}</p>` +
      `<button id="manage-2fa" onclick="location.href='/done?item=2fa'">Manage</button></li></ul></section>`,
    items: [
      ["manage-push", "Push alerts", "push"],
      ["manage-email", "Email digests", "email"],
    ],
  },
  dialog: {
    sentence: "click Remove for Grace Hopper",
    row: (id, name, item) =>
      `<div class="member"><span class="who">${name}</span><p>${LONG}</p>` +
      `<button id="${id}" onclick="location.href='/done?item=${item}'">Remove</button></div>`,
    wrap: (rows) =>
      `<main><p>Projects</p></main><dialog open><h2>Team members</h2>${rows}</dialog>`,
    items: [
      ["remove-ada", "Ada Lovelace", "ada"],
      ["remove-grace", "Grace Hopper", "grace"],
    ],
  },
};
type StructureName = keyof typeof STRUCTURES;

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "bounded-context sentence recipes through the flow runner",
  () => {
    let server: Server;
    let base = "";
    let root = "";
    const state = {
      cards: [backpack, onesie, light] as Card[],
      long: true,
      cover: false,
      later: [] as Card[],
      duplicate: false,
    };
    const chosen: string[] = [];
    const messages: Record<string, string> = { backpack: "Backpack added" };

    function structure(name: StructureName): string {
      const layout = STRUCTURES[name];
      const target = layout.items[1]!;
      const items = state.duplicate
        ? [...layout.items, [`${target[0]}-v2`, target[1], "dup"] as const]
        : layout.items;
      return layout.wrap(items.map((item) => layout.row(...item)).join(""));
    }

    function inventory(): string {
      const cover = state.cover
        ? `<div id="cover" style="position:fixed;inset:0;background:white"></div>` +
          `<script>setTimeout(() => {` +
          `document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(state.later.map((item) => card(item, state.long)).join(""))});` +
          `document.querySelector('#cover').remove(); }, 600);</script>`
        : "";
      return `<main>${state.cards.map((item) => card(item, state.long)).join("")}</main>${cover}`;
    }

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "sedum-bounded-cache-"));
      server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture.test");
        response.writeHead(200, { "content-type": "text/html" });
        if (url.pathname === "/done") {
          const item = url.searchParams.get("item") ?? "";
          chosen.push(item);
          response.end(`<h1>${messages[item] ?? `Added ${item}`}</h1>`);
          return;
        }
        if (url.pathname === "/native-table") {
          response.end(
            "<table><tbody>" +
              ["Grace Hopper", "Ada Lovelace"]
                .map(
                  (name, index) =>
                    `<tr><td>${name}</td><td>${LONG}</td><td><button id="edit-${index}" ` +
                    `onclick="location.href='/done?item=${index}'">Edit</button></td></tr>`,
                )
                .join("") +
              "</tbody></table>",
          );
          return;
        }
        const layout = url.pathname.slice(1);
        const body =
          layout in STRUCTURES
            ? structure(layout as StructureName)
            : inventory();
        response.end(`<!doctype html><html><body>${body}</body></html>`);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture port missing");
      base = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    function reset(): void {
      Object.assign(state, {
        cards: [backpack, onesie, light],
        long: true,
        cover: false,
        later: [],
        duplicate: false,
      });
      chosen.length = 0;
    }

    interface Run {
      readonly store: CacheStore;
      readonly choose: Resolver["choose"];
      readonly id: string;
      readonly at?: string;
    }

    async function run(steps: readonly string[], options: Run) {
      const { store, choose, id, at = "/" } = options;
      const file = path.join(root, `${id}.test.yaml`);
      await writeFile(
        file,
        `url: ${base}${at}\nsteps:\n${steps.map((step) => `  - ${step}\n`).join("")}`,
      );
      const recorder = new RunRecorder(async () => undefined, id);
      await recorder.start();
      const flow = await runFlow(file, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        browserKind: "chromium",
        classificationCache: new NoopClassificationCache(),
        locatorCache: store,
        provider: { classifyBatch: vi.fn(), choose, holds: vi.fn() },
        env: {},
        report: {
          recorder,
          privacy: { secretValues: [], sensitiveOrigins: [] },
          evidenceEnabled: false,
          replay: false,
          saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
        },
      });
      await recorder.finish();
      const step = recorder.snapshot.tests[0]?.attempts[0]?.steps[0];
      return { flow, locator: step?.locator };
    }

    async function warmed(seed: number) {
      reset();
      const cache = persistedStore(seed);
      const choose = chooseTitle("Sauce Labs Backpack");
      const cold = await run([SENTENCE], {
        store: cache.store,
        choose,
        id: `cold-${seed}`,
      });
      expect(cold.flow.status).toBe("passed");
      expect(cold.locator?.cache).toMatchObject({ reason: "absent" });
      expect(cache.entries().map((entry) => entry.boundedContext)).toEqual([
        true,
      ]);
      return { ...cache, choose };
    }

    it("hits the bounded recipe in a fresh context, after reordering and insertion", async () => {
      const { store, choose } = await warmed(41);
      state.cards = [
        light,
        { id: "add-fleece", title: "Sauce Labs Fleece Jacket", item: "fleece" },
        onesie,
        backpack,
      ];
      const warm = await run([SENTENCE], { store, choose, id: "warm-41" });
      expect(warm.flow.status).toBe("passed");
      expect(warm.locator).toMatchObject({
        source: "cache",
        confidence: null,
        options: [],
        cache: { outcome: "hit", fallbackCalledModel: false },
      });
      expect(choose).toHaveBeenCalledTimes(1);
      expect(chosen).toEqual(["backpack", "backpack"]);
    }, 30_000);

    it.each([
      [
        "a same-context duplicate with a new ID",
        () => [
          { id: "add-backpack-v2", title: "Sauce Labs Backpack", item: "dup" },
          backpack,
          onesie,
        ],
        "context_not_unique",
      ],
      [
        "a disabled same-context duplicate",
        () => [
          backpack,
          {
            id: "add-backpack-v2",
            title: "Sauce Labs Backpack",
            item: "dup",
            disabled: true,
          },
          onesie,
        ],
        "context_not_unique",
      ],
      [
        "the original ID on another card",
        () => [
          { ...onesie, id: backpack.id! },
          { ...backpack, id: onesie.id! },
        ],
        "strong_signal_conflict",
      ],
    ] as const)(
      "misses before dispatch beside %s",
      async (_name, cards, reason) => {
        const { store, choose } = await warmed(42);
        state.cards = cards();
        const warm = await run([SENTENCE], { store, choose, id: "miss-42" });
        expect(warm.locator).toMatchObject({
          source: "model",
          cache: { outcome: "miss", reason, fallbackCalledModel: true },
        });
        expect(store.invalidate).toHaveBeenCalledTimes(1);
        expect(choose).toHaveBeenCalledTimes(2);
        expect(chosen[0]).toBe("backpack");
        expect(chosen).toHaveLength(2);
      },
      30_000,
    );

    it("rechecks a cached target after a pre-dispatch refusal and page change", async () => {
      const { store, choose } = await warmed(43);
      state.cover = true;
      state.later = [
        { id: "add-backpack-v2", title: "Sauce Labs Backpack", item: "dup" },
      ];
      const warm = await run([SENTENCE], { store, choose, id: "recover-43" });
      expect(warm.flow.status).toBe("passed");
      // One model call in this run: the first lookup hit (an earlier miss would
      // have called the model); the covered target refused input, and the
      // re-observation after the page changed found the new duplicate.
      expect(choose).toHaveBeenCalledTimes(2);
      expect(warm.locator).toMatchObject({
        source: "model",
        cache: { outcome: "miss", reason: "context_not_unique" },
      });
      expect(chosen).toEqual(["backpack", "backpack"]);
      expect(store.invalidate).toHaveBeenCalledTimes(1);
    }, 30_000);

    it("hits an unchanged-looking bounded target whose handler changed; the assertion fails", async () => {
      const { store, choose } = await warmed(44);
      messages.backpack = "Onesie added";
      try {
        const warm = await run(
          [SENTENCE, 'verify "Backpack added" appears once'],
          { store, choose, id: "handler-44" },
        );
        expect(warm.locator?.cache).toMatchObject({ outcome: "hit" });
        expect(warm.flow.status).toBe("failed");
      } finally {
        messages.backpack = "Backpack added";
      }
    }, 30_000);

    it.each(Object.keys(STRUCTURES) as StructureName[])(
      "admits, hits and guards the bounded path in the %s layout",
      async (name) => {
        reset();
        const layout = STRUCTURES[name];
        const target = layout.items[1]!;
        const { store, entries } = persistedStore(46);
        const choose = chooseTitle(target[1]);
        const steps = [layout.sentence];
        const at = `/${name}`;
        const cold = await run(steps, {
          store,
          choose,
          id: `${name}-cold`,
          at: at,
        });
        expect(cold.flow.status).toBe("passed");
        expect(entries().map((entry) => entry.boundedContext)).toEqual([true]);
        const warm = await run(steps, {
          store,
          choose,
          id: `${name}-warm`,
          at: at,
        });
        expect(warm.locator?.cache).toMatchObject({ outcome: "hit" });
        state.duplicate = true;
        const dup = await run(steps, {
          store,
          choose,
          id: `${name}-dup`,
          at: at,
        });
        expect(dup.locator?.cache).toMatchObject({
          outcome: "miss",
          reason: "context_not_unique",
          fallbackCalledModel: true,
        });
        expect(choose).toHaveBeenCalledTimes(2);
        expect(chosen).toEqual([target[2], target[2], target[2]]);
      },
      30_000,
    );

    it("never caches native table rows, which carry no row context today", async () => {
      reset();
      const { store } = persistedStore(47);
      const choose = vi.fn(
        async (_sentence: string, offered: ResolverCandidates) => {
          const options = offered.options.filter(
            (option) => option.kind === "candidate",
          );
          const ids = options.map((option) => option.candidate.id);
          return {
            selection: { kind: "candidate" as const, id: ids[1]! },
            probabilities: Object.fromEntries([
              ...ids.map((id, index) => [id, index === 1 ? 0.9 : 0.05]),
              ["none", 0.05],
            ]),
            confidence: null,
            call,
          };
        },
      );
      const steps = ["click Edit for Ada Lovelace"];
      for (const id of ["table-cold", "table-warm"]) {
        const result = await run(steps, {
          store,
          choose,
          id: id,
          at: "/native-table",
        });
        expect(result.locator?.cache).toMatchObject({
          outcome: "miss",
          reason: "not_cacheable",
        });
      }
      expect(store.put).not.toHaveBeenCalled();
      expect(chosen).toEqual(["1", "1"]);
    }, 30_000);

    it("reports short complete-context cards as the existing path, not bounded evidence", async () => {
      reset();
      state.long = false;
      const { store, entries } = persistedStore(45);
      const choose = chooseTitle("Sauce Labs Backpack");
      expect(
        (await run([SENTENCE], { store, choose, id: "short-45" })).flow.status,
      ).toBe("passed");
      expect(entries()).toHaveLength(1);
      expect("boundedContext" in entries()[0]!).toBe(false);
      state.cards = [
        { id: "add-backpack-v2", title: "Sauce Labs Backpack", item: "dup" },
        backpack,
        onesie,
      ];
      // Known limitation of the existing complete-context path, recorded for a
      // separate decision: it has no warm uniqueness recheck, so the original
      // card still hits beside a same-context duplicate with a new ID.
      const warm = await run([SENTENCE], { store, choose, id: "short-dup-45" });
      expect(warm.locator?.cache).toMatchObject({ outcome: "hit" });
      expect(chosen).toEqual(["backpack", "backpack"]);
    }, 30_000);
  },
);
