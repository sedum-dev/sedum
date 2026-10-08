import { describe, expect, it } from "vitest";
import { matchEntry, stageEntry } from "./page-cache.js";
import {
  PEER_LIMIT,
  type Candidate,
  type CandidatePage,
} from "./page-protocol.js";

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

  it.each(["button", "link"])(
    "preserves %s as a meaningful product clue",
    (noun) => {
      const target = product("target", `${noun} Camera`);
      const competitor = product("other", "Camera");
      const text = `click the Add to cart button for ${noun} Camera`;
      const entry = stageEntry(
        key,
        route,
        "click",
        text,
        target,
        page([target, competitor]),
      );
      expect(entry.boundedContext).toBe(true);
      expect(
        matchEntry(
          entry,
          key,
          route,
          "click",
          text,
          [competitor, target],
          true,
        ),
      ).toEqual({
        hit: true,
        candidate: target,
      });
      expect(() =>
        stageEntry(
          key,
          route,
          "click",
          text,
          competitor,
          page([target, competitor]),
        ),
      ).toThrow("candidate_not_distinguishable");
    },
  );

  it.each(["button", "link"])(
    "admits the matching role noun %s only after the full label",
    (role) => {
      const target: Candidate = {
        ...backpack,
        tag: role === "link" ? "a" : "button",
        role,
        name: "Final Checkout",
        peers: [],
        signals: { id: "checkout", path: "body:0/button:0" },
      };
      const text = `click the Final Checkout ${role}`;
      const entry = stageEntry(
        key,
        route,
        "click",
        text,
        target,
        page([target]),
      );
      expect(
        matchEntry(entry, key, route, "click", text, [target], true).hit,
      ).toBe(true);
      for (const invalid of [
        `click the Checkout ${role}`,
        `click ${role} Final Checkout`,
        `click Final Checkout ${role === "link" ? "button" : "link"}`,
      ]) {
        expect(() =>
          stageEntry(key, route, "click", invalid, target, page([target])),
        ).toThrow("candidate_not_distinguishable");
      }
    },
  );

  it.each(["add to cart", "Add  to cart", "ADD TO CART"])(
    "rejects contextual twins with label %s",
    (name) => {
      const twin = { ...product("twin", "Sauce Labs Backpack"), name };
      expect(match([backpack, twin]).hit).toBe(false);
      expect(() => stage(backpack, [backpack, twin])).toThrow(
        "candidate_not_distinguishable",
      );
    },
  );

  it.each([
    { peers: [] },
    { peers: ["$10"] },
    { peers: ["x".repeat(PEER_LIMIT)] },
  ])("refuses unknown or bounded competitor context %j", ({ peers }) => {
    const twin = { ...product("twin", "Unknown"), peers };
    expect(match([backpack, twin]).hit).toBe(false);
    expect(() => stage(backpack, [backpack, twin])).toThrow(
      "candidate_not_distinguishable",
    );
  });

  it("rejects a potentially truncated selected peer, but accepts below the bound", () => {
    const text = "click Add to cart button for Camera";
    const title = `Camera ${"x".repeat(PEER_LIMIT - 7)}`;
    const target = product("camera", title);
    expect(() =>
      stageEntry(key, route, "click", text, target, page([target])),
    ).toThrow("candidate_not_distinguishable");
    const shorter = { ...target, peers: [title.slice(0, -1)] };
    expect(
      stageEntry(key, route, "click", text, shorter, page([shorter]))
        .boundedContext,
    ).toBe(true);
  });

  it("does not treat a disabled contextual duplicate as evidence of uniqueness", () => {
    const disabledTwin = {
      ...product("twin", "Sauce Labs Backpack"),
      disabled: true,
    };
    expect(match([backpack, disabledTwin]).hit).toBe(false);
  });

  it("does not admit a negative qualifier by sharing a positive title word", () => {
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "click Add to cart button for Sauce Labs not Backpack",
        backpack,
        page([backpack, onesie]),
      ),
    ).toThrow("candidate_not_distinguishable");
  });

  it("does not use lossy container labels to supply a missing peer clue", () => {
    const text = "click the Approve button for Alice in Pending";
    const pending = {
      ...product("pending-alice", "Alice"),
      name: "Approve",
      signals: { ...backpack.signals, id: "pending-alice", section: "Pending" },
    };
    const archived = {
      ...pending,
      ref: "archived",
      signals: {
        ...pending.signals,
        id: "archived-alice",
        section: "Archived",
      },
    };
    expect(() =>
      stageEntry(key, route, "click", text, pending, page([archived, pending])),
    ).toThrow("candidate_not_distinguishable");
  });

  it.each([3, 4])("invalidates earlier matcher %s entries", (matcher) => {
    expect(
      matchEntry(
        { ...stage(), matcher },
        key,
        route,
        "click",
        sentence,
        [backpack, onesie],
        true,
      ),
    ).toEqual({ hit: false, reason: "matcher_mismatch" });
  });
});

describe("contested control nouns", () => {
  it.each(["button", "link"])(
    "rejects competing %s names at admission and on warm matches",
    (role) => {
      const target = {
        ...product("checkout", ""),
        name: "Final Checkout",
        role,
        tag: role === "link" ? "a" : "button",
        peers: [],
      };
      const text = `click the Final Checkout ${role}`;
      const entry = stageEntry(
        key,
        route,
        "click",
        text,
        target,
        page([target]),
      );
      for (const disabled of [false, true]) {
        const competitor = {
          ...target,
          ref: "competitor",
          name: `Final Checkout ${role}`,
          disabled,
          signals: { id: "competitor", path: "body:0/button:1" },
        };
        const all = [target, competitor];
        expect(() =>
          stageEntry(key, route, "click", text, target, page(all)),
        ).toThrow("candidate_not_distinguishable");
        expect(matchEntry(entry, key, route, "click", text, all, true)).toEqual(
          { hit: false, reason: "context_not_unique" },
        );
      }
      const exact = {
        ...target,
        ref: "exact",
        name: `Final Checkout ${role}`,
        signals: { id: "exact", path: "body:0/button:1" },
      };
      const exactEntry = stageEntry(
        key,
        route,
        "click",
        text,
        exact,
        page([target, exact]),
      );
      expect(
        matchEntry(
          exactEntry,
          key,
          route,
          "click",
          text,
          [target, exact],
          true,
        ),
      ).toEqual({ hit: true, candidate: exact });
    },
  );

  it.each([false, true])(
    "checks contextual recipes with complete=%s",
    (contextComplete) => {
      const target = {
        ...backpack,
        signals: { ...backpack.signals, contextComplete },
      };
      const entry = stageEntry(
        key,
        route,
        "click",
        sentence,
        target,
        page([target]),
      );
      expect(entry.boundedContext === true).toBe(!contextComplete);
      const help = { ...product("help", ""), name: "Help BUTTON" };
      expect(
        matchEntry(entry, key, route, "click", sentence, [target, help], true),
      ).toEqual({ hit: false, reason: "context_not_unique" });
      expect(
        matchEntry(
          entry,
          key,
          route,
          "click",
          sentence,
          [target, { ...help, role: "link", tag: "a" }],
          true,
        ),
      ).toEqual({ hit: true, candidate: target });
    },
  );

  it("keeps noun-free sentences cacheable beside noun-bearing controls", () => {
    const target = { ...product("checkout", ""), name: "Checkout", peers: [] };
    const other = { ...product("other", ""), name: "Help button", peers: [] };
    const text = "click Checkout";
    const all = [target, other];
    const entry = stageEntry(key, route, "click", text, target, page(all));
    expect(matchEntry(entry, key, route, "click", text, all, true)).toEqual({
      hit: true,
      candidate: target,
    });
  });
});
