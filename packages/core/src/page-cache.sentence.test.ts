import { describe, expect, it } from "vitest";
import {
  MATCHER_VERSION,
  matchEntry,
  stageEntry,
  type CacheEntry,
} from "./page-cache.js";
import type { Candidate, CandidatePage } from "./page-protocol.js";

const key = new Uint8Array(32).fill(17);
const route = "https://fixture.test/checkout";

function control(
  name: string,
  id: string | undefined,
  options: Partial<Candidate> = {},
): Candidate {
  const role = options.role ?? "button";
  return {
    ref: id ?? name,
    tag: role === "link" ? "a" : "button",
    role,
    name,
    peers: [],
    editable: false,
    disabled: false,
    inputType: "",
    signals: { ...(id ? { id } : {}), path: `body:0/${id ?? name}:0` },
    ...options,
  };
}
function page(candidates: readonly Candidate[]): CandidatePage {
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
const stage = (sentence: string, target: Candidate, all = [target]) =>
  stageEntry(key, route, "click", sentence, target, page(all));
const match = (
  entry: CacheEntry,
  sentence: string,
  candidates: readonly Candidate[],
) => matchEntry(entry, key, route, "click", sentence, candidates, true);

const checkout = control("Checkout", "checkout");
const finish = control("Finish", "finish");
const docs = control("Docs", "docs", {
  role: "link",
  signals: { id: "docs", href: "/docs", path: "body:0/a:0" },
});
const checkoutButton = control("Checkout button", "checkout-promo");

describe("control nouns in sentence recipes", () => {
  it("uses matcher version 2 for the warm control-noun guard", () => {
    expect(MATCHER_VERSION).toBe(2);
  });

  it.each([
    ["click the Checkout button", checkout],
    ["click the Finish button", finish],
    ["click the button Checkout", checkout],
    ["click the Docs link", docs],
  ])("stages and hits %s", (sentence, target) => {
    const other = control("Cancel", "cancel");
    const entry = stage(sentence, target, [target, other]);
    expect(match(entry, sentence, [other, target])).toEqual({
      hit: true,
      candidate: target,
    });
  });

  it.each([
    [
      "the noun contradicts the chosen role",
      "click the Checkout link",
      checkout,
    ],
    ["the noun is content", "click the Checkout for the Red Button", checkout],
    [
      "a negative qualifier remains",
      "click the Checkout button not Cancel",
      checkout,
    ],
    [
      "the target has no stable signal",
      "click the Checkout button",
      control("Checkout", undefined),
    ],
    [
      "the target is disabled",
      "click the Checkout button",
      control("Checkout", "checkout", { disabled: true }),
    ],
  ])("does not stage when %s", (_name, sentence, target) => {
    expect(() => stage(sentence, target)).toThrow(
      "candidate_not_distinguishable",
    );
  });

  it.each([
    ["two same-name buttons", [checkout, control("Checkout", "checkout-2")]],
    [
      "a same-name button and link",
      [checkout, control("Checkout", undefined, { role: "link" })],
    ],
    ["a same-role control named with the noun", [checkout, checkoutButton]],
  ])("does not stage the bare label beside %s", (_name, all) => {
    expect(() => stage("click the Checkout button", checkout, all)).toThrow(
      "candidate_not_distinguishable",
    );
  });

  it("keeps exact-name admission when the noun is part of the chosen label", () => {
    const sentence = "click the Checkout button";
    const entry = stage(sentence, checkoutButton, [checkout, checkoutButton]);
    expect(match(entry, sentence, [checkout, checkoutButton])).toEqual({
      hit: true,
      candidate: checkoutButton,
    });
  });

  it("misses when a noun-bearing competitor appears after staging", () => {
    const sentence = "click the Checkout button";
    const entry = stage(sentence, checkout);
    expect(match(entry, sentence, [checkout, checkoutButton])).toEqual({
      hit: false,
      reason: "context_not_unique",
    });
    expect(
      match(entry, sentence, [checkout, control("Help button", undefined)]),
    ).toEqual({ hit: false, reason: "context_not_unique" });
    expect(
      match(entry, sentence, [
        checkout,
        control("Docs button", undefined, { role: "link" }),
      ]),
    ).toEqual({ hit: true, candidate: checkout });
  });

  it("does not hit an overlapping label or a changed identity", () => {
    const sentence = "click the Checkout button";
    const now = control("Checkout now", "checkout-now");
    const entry = stage(sentence, checkout, [checkout, now]);
    expect(match(entry, sentence, [now, checkout])).toEqual({
      hit: true,
      candidate: checkout,
    });
    expect(match(entry, sentence, [now])).toEqual({
      hit: false,
      reason: "target_missing",
    });
    expect(
      match(entry, sentence, [control("Checkout", "other-id"), now]).hit,
    ).toBe(false);
  });

  it("misses older matcher versions so they are invalidated", () => {
    const sentence = "click the Checkout button";
    const entry = stage(sentence, checkout);
    expect(match({ ...entry, matcher: 1 }, sentence, [checkout])).toEqual({
      hit: false,
      reason: "matcher_mismatch",
    });
  });

  it("keeps complete-context recipes conservative when the noun is contested", () => {
    const camera = control("Add to cart", "camera", {
      peers: ["Camera"],
      signals: {
        id: "camera",
        path: "body:0/article:0/button:0",
        contextComplete: true,
      },
    });
    const lens = control("Add to cart", "lens", {
      peers: ["Lens"],
      signals: {
        id: "lens",
        path: "body:0/article:1/button:0",
        contextComplete: true,
      },
    });
    const sentence = "click the Add to cart button for Camera";
    const entry = stage(sentence, camera, [camera, lens]);
    expect(match(entry, sentence, [lens, camera])).toEqual({
      hit: true,
      candidate: camera,
    });
    expect(() =>
      stage(sentence, camera, [camera, lens, control("Help button", "help")]),
    ).toThrow("candidate_not_distinguishable");
  });

  it("leaves fill recipes keyed by the target alone", () => {
    const email = control("Email", "email", {
      tag: "input",
      role: "textbox",
      editable: true,
      inputType: "email",
    });
    const sentence = "type in the Email field";
    const entry = stageEntry(
      key,
      route,
      "fill",
      sentence,
      email,
      page([email]),
    );
    expect(
      matchEntry(entry, key, route, "fill", sentence, [email], true),
    ).toEqual({ hit: true, candidate: email });
    expect(
      matchEntry(entry, key, route, "click", sentence, [email], true),
    ).toEqual({ hit: false, reason: "target_missing" });
  });
});
