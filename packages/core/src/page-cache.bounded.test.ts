import { describe, expect, it } from "vitest";
import { matchEntry, stageEntry, type CacheEntry } from "./page-cache.js";
import type { Candidate, CandidatePage } from "./page-protocol.js";

const key = new Uint8Array(32).fill(19);
const route = "https://fixture.test/inventory";
const description =
  "A long product description that the candidate scanner bounded to its limit";

/** A repeated "Add to cart" button whose card context is bounded, not complete. */
function product(
  id: string | undefined,
  title: string,
  options: Partial<Candidate> = {},
): Candidate {
  return {
    ref: id ?? title,
    tag: "button",
    role: "button",
    name: "Add to cart",
    peers: [title, description],
    editable: false,
    disabled: false,
    inputType: "",
    signals: {
      ...(id ? { id } : {}),
      path: `body:0/div:${id ?? title}/button:0`,
      contextComplete: false,
    },
    ...options,
  };
}
function page(
  candidates: readonly Candidate[],
  complete = true,
): CandidatePage {
  return {
    protocol: 1,
    version: { document: "d", route, revision: 0 },
    total: candidates.length,
    offset: 0,
    next: null,
    complete,
    candidates,
  };
}
const forItem = (title: string) => `click Add to cart for ${title}`;
const stage = (sentence: string, target: Candidate, all: Candidate[]) =>
  stageEntry(key, route, "click", sentence, target, page(all));
const match = (
  entry: CacheEntry,
  sentence: string,
  candidates: readonly Candidate[],
  complete = true,
) => matchEntry(entry, key, route, "click", sentence, candidates, complete);
const refusal = "candidate_not_distinguishable";

const backpack = product("add-backpack", "Sauce Labs Backpack");
const onesie = product("add-onesie", "Sauce Labs Onesie");
const light = product("add-light", "Sauce Labs Bike Light");
const catalog = [backpack, light, onesie];
const sentence = forItem("Sauce Labs Backpack");

describe("bounded-context sentence recipes", () => {
  it.each([
    ["Sauce Labs Backpack", backpack],
    ["Sauce Labs Onesie", onesie],
    ["the Sauce Labs Bike Light", light],
  ])("admits %s by its full title and hits only that card", (title, target) => {
    const entry = stage(forItem(title), target, catalog);
    expect(entry.boundedContext).toBe(true);
    expect(match(entry, forItem(title), [...catalog].reverse())).toEqual({
      hit: true,
      candidate: target,
    });
  });

  it("keeps other admission paths unflagged", () => {
    const checkout = product("checkout", "", {
      name: "Checkout",
      peers: [],
    });
    const entry = stage("click the Checkout button", checkout, [checkout]);
    expect("boundedContext" in entry).toBe(false);
    const complete = product("add-camera", "Camera", {
      signals: { id: "add-camera", path: "p", contextComplete: true },
    });
    expect(
      "boundedContext" in
        stage(forItem("Camera"), complete, [complete, backpack]),
    ).toBe(false);
  });

  it.each([
    ["a single shared word", forItem("Sauce Labs"), backpack],
    [
      "a modifier the title lacks",
      forItem("the small Sauce Labs Backpack"),
      backpack,
    ],
    ["a negation", `${sentence} not the Onesie`, backpack],
    ["another card's title", sentence, onesie],
    ["a short CJK title", forItem("背包"), product("add-bag", "背包 黑色")],
    ["no residual clue", "click Add to cart", backpack],
  ])("does not admit %s", (_name, text, target) => {
    expect(() => stage(text, target, [...catalog, target])).toThrow(refusal);
  });

  it.each([
    [
      "no ID, only a shared hook",
      product(undefined, "Sauce Labs Backpack", {
        signals: { hook: "add-to-cart", path: "p", contextComplete: false },
      }),
    ],
    [
      "an input button",
      product("add-backpack", "Sauce Labs Backpack", {
        tag: "input",
        inputType: "submit",
      }),
    ],
    [
      "a link",
      product("add-backpack", "Sauce Labs Backpack", {
        tag: "a",
        role: "link",
      }),
    ],
    ["a price-only peer", product("add-backpack", "$29.99")],
  ])("does not admit %s", (_name, target) => {
    expect(() => stage(sentence, target, [target, onesie])).toThrow(refusal);
  });

  it.each([
    ["the same ID", [backpack, onesie, { ...backpack, ref: "clone" }]],
    [
      "a different ID",
      [backpack, onesie, product("other", "Sauce Labs Backpack")],
    ],
    [
      "a disabled duplicate",
      [
        backpack,
        onesie,
        product("other", "Sauce Labs Backpack", { disabled: true }),
      ],
    ],
    [
      "a differently cased name",
      [
        backpack,
        onesie,
        product("other", "Sauce Labs Backpack", { name: " add TO cart " }),
      ],
    ],
  ])("does not admit beside a same-context card with %s", (_name, all) => {
    expect(() => stage(sentence, backpack, all)).toThrow(refusal);
  });

  it("does not count a same-named control of another role as a duplicate", () => {
    const link = product("cart-link", "Sauce Labs Backpack", {
      tag: "a",
      role: "link",
    });
    expect(stage(sentence, backpack, [backpack, link]).boundedContext).toBe(
      true,
    );
  });

  it("misses a new same-context duplicate even when the original ID outscores it", () => {
    const entry = stage(sentence, backpack, catalog);
    for (const duplicate of [
      product("new-id", "Sauce Labs Backpack"),
      product("new-id", "Sauce Labs Backpack", { disabled: true }),
      product(undefined, "Sauce Labs Backpack"),
    ])
      expect(match(entry, sentence, [...catalog, duplicate])).toEqual({
        hit: false,
        reason: "context_not_unique",
      });
  });

  it("misses when the ID moves to another card or the peers change", () => {
    const entry = stage(sentence, backpack, catalog);
    const moved = product("add-backpack", "Sauce Labs Onesie");
    expect(match(entry, sentence, [moved, light]).hit).toBe(false);
    const renamed = product("add-backpack", "Sauce Labs Backpack 2");
    expect(match(entry, sentence, [renamed, onesie]).hit).toBe(false);
    const swapped = [
      product("add-onesie", "Sauce Labs Backpack"),
      product("add-backpack", "Sauce Labs Onesie"),
    ];
    expect(match(entry, sentence, swapped).hit).toBe(false);
  });

  it("hits after reordering, moving, or inserting an unrelated card", () => {
    const entry = stage(sentence, backpack, catalog);
    const relocated = {
      ...backpack,
      ref: "fresh",
      signals: { ...backpack.signals, path: "body:0/div:9/button:0" },
    };
    const fleece = product("add-fleece", "Sauce Labs Fleece Jacket");
    expect(match(entry, sentence, [fleece, onesie, relocated, light])).toEqual({
      hit: true,
      candidate: relocated,
    });
  });

  it("never establishes uniqueness from a partial or disabled observation", () => {
    expect(() =>
      stageEntry(key, route, "click", sentence, backpack, page(catalog, false)),
    ).toThrow(refusal);
    const entry = stage(sentence, backpack, catalog);
    expect(match(entry, sentence, catalog, false)).toEqual({
      hit: false,
      reason: "candidate_set_incomplete",
    });
    expect(
      match(entry, sentence, [{ ...backpack, disabled: true }, onesie]).hit,
    ).toBe(false);
  });

  it("separates overlapping titles and ignores another card's description", () => {
    const pro = product("add-pro", "Sauce Labs Backpack Pro");
    expect(() => stage(sentence, backpack, [backpack, pro])).toThrow(refusal);
    const proSentence = forItem("Sauce Labs Backpack Pro");
    expect(stage(proSentence, pro, [backpack, pro]).boundedContext).toBe(true);
    const helmet = product("add-helmet", "Helmet", {
      peers: ["Helmet", "Pairs with the Sauce Labs Backpack"],
    });
    expect(stage(sentence, backpack, [backpack, helmet]).boundedContext).toBe(
      true,
    );
    const shared = (id: string) =>
      product(id, "Sale Sauce Labs Backpack and Onesie bundle");
    expect(() =>
      stage(sentence, shared("a"), [shared("a"), shared("b")]),
    ).toThrow(refusal);
  });

  it("normalizes Unicode, case, punctuation and word order", () => {
    const shirt = product("add-shirt", "Sauce Labs Bolt T-Shirt");
    const red = product("add-red", "Test.allTheThings() T-Shirt (Red)");
    const text = "click Add to cart for the sauce labs BOLT t‑shirt!";
    expect(stage(text, shirt, [shirt, red]).boundedContext).toBe(true);
    const cafe = product("add-cafe", "Café Crème");
    const decomposed = forItem("Cafe\u0301 Cre\u0300me");
    expect(stage(decomposed, cafe, [cafe, onesie]).boundedContext).toBe(true);
    expect(
      stage(forItem("Backpack Sauce Labs"), backpack, catalog).boundedContext,
    ).toBe(true);
  });

  it("invalidates older matchers and malformed admission flags", () => {
    const entry = stage(sentence, backpack, catalog);
    for (const matcher of [1, 2])
      expect(match({ ...entry, matcher }, sentence, catalog)).toEqual({
        hit: false,
        reason: "matcher_mismatch",
      });
    for (const flag of ["yes", 1, null])
      expect(
        match({ ...entry, boundedContext: flag as never }, sentence, catalog),
      ).toEqual({ hit: false, reason: "corrupt" });
    expect(
      match(
        { ...entry, digests: { ...entry.digests, peers: ["bad"] } },
        sentence,
        catalog,
      ),
    ).toEqual({ hit: false, reason: "corrupt" });
  });
});
