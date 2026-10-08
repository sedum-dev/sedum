import { describe, expect, it } from "vitest";
import { matchEntry, stageEntry } from "./page-cache.js";
import type { Candidate, CandidatePage } from "./page-protocol.js";

const key = new Uint8Array(32).fill(17);
const route = "https://fixture.test/catalog";
const sentence = "click the Add to cart button for Sauce Labs Backpack";
function product(id: string, title: string): Candidate {
  return {
    ref: id,
    tag: "button",
    role: "button",
    name: "Add to cart",
    peers: [title, "A long product description that was bounded"],
    editable: false,
    disabled: false,
    inputType: "",
    signals: { id, path: "body:0/div:0/button:0", contextComplete: false },
  };
}
const backpack = product("backpack", "Sauce Labs Backpack");
const onesie = product("onesie", "Sauce Labs Onesie");
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
function stage(target = backpack, candidates = [target, onesie]) {
  return stageEntry(key, route, "click", sentence, target, page(candidates));
}
function match(candidates: Candidate[], complete = true) {
  return matchEntry(
    stage(),
    key,
    route,
    "click",
    sentence,
    candidates,
    complete,
  );
}

describe("bounded sentence context recipes", () => {
  it("admits full product clues with a unique ID without relying on candidate order/path", () => {
    expect(stage().boundedContext).toBe(true);
    const moved = {
      ...backpack,
      ref: "fresh",
      signals: { ...backpack.signals, path: "body:0/div:3/button:0" },
    };
    expect(match([onesie, moved])).toEqual({ hit: true, candidate: moved });
  });
  it.each(["Checkout", "Finish"])("treats button as grammar for %s", (name) => {
    const target = {
      ...backpack,
      name,
      peers: [],
      signals: { id: name, path: "body:0/button:0" },
    };
    const text = `click the ${name} button`;
    const entry = stageEntry(key, route, "click", text, target, page([target]));
    expect(
      matchEntry(entry, key, route, "click", text, [target], true).hit,
    ).toBe(true);
  });
  it.each([
    {
      name: "partial shared title",
      target: product("backpack", "Sauce Labs Onesie"),
    },
    {
      name: "shared hook without ID",
      target: {
        ...backpack,
        signals: { path: "body:0/button:0", hook: "shared" },
      },
    },
    {
      name: "input button",
      target: { ...backpack, tag: "input", inputType: "submit" },
    },
  ])("does not admit $name", ({ target }) => {
    expect(() => stage(target)).toThrow("candidate_not_distinguishable");
  });
  it.each([
    ["missing", [onesie]],
    ["same ID clone", [backpack, { ...backpack, ref: "clone" }]],
    [
      "same context different ID",
      [backpack, product("other-id", "Sauce Labs Backpack")],
    ],
    ["disabled", [{ ...backpack, disabled: true }, onesie]],
    ["renamed", [{ ...backpack, name: "Remove" }, onesie]],
    [
      "context shifted under original ID",
      [product("backpack", "Sauce Labs Onesie"), onesie],
    ],
    ["conflicting ID", [product("new-id", "Sauce Labs Backpack"), onesie]],
  ] as const)("misses %s instead of a wrong hit", (_name, candidates) => {
    expect(match([...candidates]).hit).toBe(false);
  });
  it("refuses ambiguous admission and incomplete snapshots", () => {
    expect(() =>
      stage(backpack, [backpack, product("other-id", "Sauce Labs Backpack")]),
    ).toThrow("candidate_not_distinguishable");
    expect(match([backpack, onesie], false)).toEqual({
      hit: false,
      reason: "candidate_set_incomplete",
    });
  });
  it("invalidates old matcher versions and corrupt admission flags", () => {
    const entry = stage();
    expect(
      matchEntry(
        { ...entry, matcher: 1 },
        key,
        route,
        "click",
        sentence,
        [backpack],
        true,
      ),
    ).toEqual({ hit: false, reason: "matcher_mismatch" });
    expect(
      matchEntry(
        { ...entry, boundedContext: "yes" as never },
        key,
        route,
        "click",
        sentence,
        [backpack],
        true,
      ),
    ).toEqual({ hit: false, reason: "corrupt" });
  });
});
