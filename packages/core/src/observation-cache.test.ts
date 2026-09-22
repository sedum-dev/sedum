import { describe, expect, it } from "vitest";
import {
  cacheKey,
  matchCacheEntry,
  stageCacheEntry,
} from "./observation-cache.js";
import type {
  ObservedCandidate,
  PageObservation,
} from "./snapshot-observation.js";

const key = Buffer.alloc(32, 7);
const route = "https://example.test/shop?q=amber#products";
const makeCandidate = (
  id: string,
  name: string,
  peer = "Amber mug",
): ObservedCandidate => ({
  id,
  tag: "button",
  role: "button",
  name,
  peers: [peer],
  editable: false,
  disabled: false,
  signals: { path: `html:0/body:1/article:${id}/button:0`, hook: `add-${id}` },
});
const observation = (
  candidates: readonly ObservedCandidate[],
): PageObservation => ({
  complete: true,
  version: { document: 1, route, signature: "snapshot" },
  candidates,
  digest: "Products",
});

describe("observation cache", () => {
  it("separates full routes and normalizes sentence whitespace without persisting raw data", () => {
    expect(cacheKey(key, route, "click", "Add  Amber mug")).toBe(
      cacheKey(key, route, "click", "Add Amber mug"),
    );
    expect(cacheKey(key, route, "click", "Add Amber mug")).not.toBe(
      cacheKey(
        key,
        "https://example.test/shop?q=blue#products",
        "click",
        "Add Amber mug",
      ),
    );
    const entry = stageCacheEntry(
      observation([makeCandidate("a", "Add to cart")]),
      "a",
      key,
      "click",
      "Add Amber mug",
      true,
    )!;
    expect(JSON.stringify(entry)).not.toMatch(
      /Amber mug|Add to cart|example\.test|\/shop|add-a/,
    );
    expect(
      stageCacheEntry(
        observation([makeCandidate("a", "Add to cart")]),
        "a",
        key,
        "click",
        "Add Amber mug",
        false,
      ),
    ).toBeUndefined();
    expect(
      matchCacheEntry(
        { ...entry, signals: { ...entry.signals, name: "not a digest" } },
        observation([makeCandidate("a", "Add to cart")]),
        key,
        "click",
        "Add Amber mug",
      ),
    ).toMatchObject({ hit: false, reason: "malformed_entry" });
  });

  it("checks competitors beyond the first Resolver page", () => {
    const candidates = Array.from({ length: 130 }, (_, index) =>
      makeCandidate(String(index), `Add item ${index}`, `Item ${index}`),
    );
    const selected = candidates[0]!;
    const entry = stageCacheEntry(
      observation(candidates),
      selected.id,
      key,
      "click",
      "Add item 0",
      true,
    )!;
    expect(
      matchCacheEntry(
        entry,
        observation(candidates),
        key,
        "click",
        "Add item 0",
      ),
    ).toEqual({ hit: true, id: "0" });
    const competitor = {
      ...candidates[129]!,
      signals: selected.signals,
      name: selected.name,
      peers: selected.peers,
    };
    expect(
      matchCacheEntry(
        entry,
        observation([...candidates.slice(0, 129), competitor]),
        key,
        "click",
        "Add item 0",
      ),
    ).toMatchObject({ hit: false, reason: "near_tie" });
  });

  it("rejects incomplete sets, strong conflicts, and runtime-dependent targets", () => {
    const selected = makeCandidate("a", "Add to cart");
    const entry = stageCacheEntry(
      observation([selected]),
      "a",
      key,
      "click",
      "Add Amber mug",
      true,
    )!;
    expect(
      matchCacheEntry(
        entry,
        { complete: false, reason: "candidate_set_incomplete", candidates: [] },
        key,
        "click",
        "Add Amber mug",
      ),
    ).toMatchObject({ hit: false, reason: "candidate_set_incomplete" });
    expect(
      matchCacheEntry(
        entry,
        observation([{ ...selected, name: "Delete" }]),
        key,
        "click",
        "Add Amber mug",
      ),
    ).toMatchObject({ hit: false, reason: "strong_signal_conflict" });
    expect(
      matchCacheEntry(
        entry,
        observation([selected]),
        key,
        "click",
        "Add Amber mug",
        true,
      ),
    ).toMatchObject({ hit: false, reason: "runtime_dependent" });
    expect(
      stageCacheEntry(
        observation([selected]),
        "a",
        key,
        "click",
        "Add Amber mug",
        true,
        true,
      ),
    ).toBeUndefined();
  });

  it("refuses to stage undistinguished duplicates", () => {
    const selected = makeCandidate("a", "Add to cart");
    const duplicate = {
      ...selected,
      id: "b",
      signals: { ...selected.signals, path: "other path" },
    };
    expect(
      stageCacheEntry(
        observation([selected, duplicate]),
        "a",
        key,
        "click",
        "Add Amber mug",
        true,
      ),
    ).toBeUndefined();
  });
});
