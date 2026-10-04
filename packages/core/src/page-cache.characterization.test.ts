import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  CACHE_FORMAT,
  keyedDigest,
  MATCHER_VERSION,
  matchEntry,
  pageKey,
  stageEntry,
  type CacheEntry,
  type MatchResult,
} from "./page-cache.js";
import type { Candidate, CandidatePage } from "./page-protocol.js";

const key = new Uint8Array(32).fill(19);
const route = "https://example.test/catalog?q=camera#featured";
const operation = "click";
const sentence = "Add Camera to cart";
const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 1000,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

function candidate(
  ref: string,
  name = "Add to cart",
  peer = "Camera",
): Candidate {
  return {
    ref,
    tag: "button",
    role: "button",
    name,
    peers: [peer],
    editable: false,
    disabled: false,
    inputType: "",
    signals: {
      hook: "cart-action",
      id: "camera-cart",
      name: "add-camera",
      href: "/cart/camera",
      path: "body:0/main:0/article:0/button:0",
      contextComplete: true,
    },
  };
}

function page(items: Candidate[], overrides: Partial<CandidatePage> = {}) {
  return {
    protocol: 1 as const,
    version: { document: "document", route, revision: 0 },
    total: items.length,
    offset: 0,
    next: null,
    complete: true,
    candidates: items,
    ...overrides,
  } satisfies CandidatePage;
}

function staged(target = candidate("target")): CacheEntry {
  return stageEntry(key, route, operation, sentence, target, page([target]));
}

type SignalMode = "match" | "missing" | "changed";
interface CandidateModes {
  readonly hook: SignalMode;
  readonly id: SignalMode;
  readonly name: SignalMode;
  readonly label: SignalMode;
  readonly href: SignalMode;
  readonly peers: SignalMode;
  readonly path: SignalMode;
}

const signalMode = gs.sampledFrom(["match", "missing", "changed"] as const);
const candidateModes = gs.record({
  hook: signalMode,
  id: signalMode,
  name: signalMode,
  label: signalMode,
  href: signalMode,
  peers: signalMode,
  path: signalMode,
});

function value(mode: SignalMode, matching: string): string | undefined {
  if (mode === "missing") return undefined;
  return mode === "match" ? matching : `changed-${matching}`;
}

function optionalValue(field: string, mode: SignalMode, matching: string) {
  const selected = value(mode, matching);
  return selected === undefined ? {} : { [field]: selected };
}

function scoredCandidate(ref: string, modes: CandidateModes): Candidate {
  const label = value(modes.label, "Add to cart") ?? "";
  const peer = value(modes.peers, "Camera");
  return {
    ...candidate(ref, label, peer ?? "Changed peer"),
    peers: peer ? [peer] : [],
    signals: {
      ...optionalValue("hook", modes.hook, "cart-action"),
      ...optionalValue("id", modes.id, "camera-cart"),
      ...optionalValue("name", modes.name, "add-camera"),
      ...optionalValue("href", modes.href, "/cart/camera"),
      path: value(modes.path, "body:0/main:0/article:0/button:0") ?? "",
      contextComplete: true,
    },
  };
}

function expectedScore(modes: CandidateModes) {
  const weighted = [
    [modes.hook, 8, true],
    [modes.id, 8, true],
    [modes.name, 3, false],
    [modes.label, 5, true],
    [modes.href, 4, false],
    [modes.peers, 5, true],
  ] as const;
  const matches = weighted.filter(([mode]) => mode === "match");
  return {
    score:
      matches.reduce((total, [, weight]) => total + weight, 0) +
      (modes.path === "match" ? 1 : 0),
    conflict: weighted.some(([mode, , strong]) => strong && mode !== "match"),
    identity: matches.length > 0,
  };
}

function expectedMatch(
  first: CandidateModes,
  second: CandidateModes,
): MatchResult {
  const ranked = [
    { ref: "first", ...expectedScore(first) },
    { ref: "second", ...expectedScore(second) },
  ].sort((left, right) => right.score - left.score);
  const [best, runnerUp] = ranked;
  if (!best || best.score === 0)
    return { hit: false, reason: "target_missing" };
  if (best.conflict) return { hit: false, reason: "strong_signal_conflict" };
  if (!best.identity || best.score < 8)
    return { hit: false, reason: "low_score" };
  if (runnerUp && best.score - runnerUp.score < 2)
    return { hit: false, reason: "near_tie" };
  return {
    hit: true,
    candidate: scoredCandidate(best.ref, best.ref === "first" ? first : second),
  };
}

function outcome(result: MatchResult) {
  return result.hit
    ? { hit: true, ref: result.candidate.ref }
    : { hit: false, reason: result.reason };
}

describe("page cache characterization", () => {
  propertyTest("preserves generated score ordering and miss precedence", () => {
    hegel.test((testCase) => {
      const first = testCase.draw(candidateModes);
      const second = testCase.draw(candidateModes);
      const actual = matchEntry(
        staged(),
        key,
        route,
        operation,
        sentence,
        [scoredCandidate("first", first), scoredCandidate("second", second)],
        true,
      );
      const expected = expectedMatch(first, second);
      if (JSON.stringify(outcome(actual)) !== JSON.stringify(outcome(expected)))
        throw new Error(
          `Matcher diverged for ${JSON.stringify({ first, second, actual: outcome(actual), expected: outcome(expected) })}`,
        );
    }, propertySettings);
  });

  it("keeps exact ties stable and applies conflict before the near-tie guard", () => {
    const matching: CandidateModes = {
      hook: "match",
      id: "match",
      name: "missing",
      label: "match",
      href: "missing",
      peers: "match",
      path: "missing",
    };
    const conflicting: CandidateModes = {
      ...matching,
      hook: "changed",
      name: "match",
      href: "match",
      path: "match",
    };
    const entry = staged();
    const match = (modes: readonly CandidateModes[]) =>
      matchEntry(
        entry,
        key,
        route,
        operation,
        sentence,
        modes.map((item, index) => scoredCandidate(String(index), item)),
        true,
      );
    expect(match([matching, matching])).toEqual({
      hit: false,
      reason: "near_tie",
    });
    expect(match([conflicting, matching])).toEqual({
      hit: false,
      reason: "strong_signal_conflict",
    });
    expect(match([matching, conflicting])).toEqual({
      hit: false,
      reason: "near_tie",
    });
  });

  it("accepts a two-point lead and rejects a one-point lead", () => {
    const entry = staged();
    const target = candidate("target");
    const onePointBehind = {
      ...target,
      ref: "one",
      signals: { ...target.signals, path: "changed" },
    };
    const twoPointsBehind = {
      ...target,
      ref: "two",
      signals: {
        ...target.signals,
        name: "changed",
        path: target.signals.path,
      },
    };
    expect(
      matchEntry(
        entry,
        key,
        route,
        operation,
        sentence,
        [target, onePointBehind],
        true,
      ),
    ).toEqual({ hit: false, reason: "near_tie" });
    expect(
      matchEntry(
        entry,
        key,
        route,
        operation,
        sentence,
        [target, twoPointsBehind],
        true,
      ),
    ).toMatchObject({ hit: true, candidate: { ref: "target" } });
  });

  it("serializes the staged recipe exactly without retaining raw signals", () => {
    const target = candidate("target");
    const entry = staged(target);
    expect(entry).toEqual({
      format: CACHE_FORMAT,
      matcher: MATCHER_VERSION,
      pageKey: pageKey(key, route, operation, sentence),
      tag: "button",
      role: "button",
      inputType: "",
      editable: false,
      disabled: false,
      path: "body:0/main:0/article:0/button:0",
      digests: {
        hook: keyedDigest(key, "cart-action"),
        id: keyedDigest(key, "camera-cart"),
        name: keyedDigest(key, "add-camera"),
        label: keyedDigest(key, "Add to cart"),
        href: keyedDigest(key, "/cart/camera"),
        peers: [keyedDigest(key, "Camera")],
      },
    });
    expect(JSON.stringify(entry)).not.toMatch(
      /cart-action|camera-cart|add-camera|Add to cart|Camera|\/cart\/camera/u,
    );
  });

  it("rejects every incomplete or inconsistent staging snapshot", () => {
    const target = candidate("target");
    const other = candidate("other", "Open details", "Camera");
    const invalidPages = [
      page([target], { complete: false }),
      page([target], { next: 1 }),
      page([target], { total: 2 }),
      page([target], {
        version: {
          document: "document",
          route: `${route}/changed`,
          revision: 0,
        },
      }),
      page([other]),
      page([target, { ...other, ref: target.ref }]),
    ];
    for (const invalid of invalidPages)
      expect(() =>
        stageEntry(key, route, operation, sentence, target, invalid),
      ).toThrow("candidate_not_distinguishable");
  });

  it("maps malformed serialized fields to corrupt without throwing", () => {
    const entry = staged();
    const malformed: CacheEntry[] = [
      { ...entry, pageKey: "A".repeat(64) },
      { ...entry, tag: 1 as never },
      { ...entry, role: "token=secret" },
      { ...entry, path: null as never },
      { ...entry, inputType: false as never },
      { ...entry, editable: "false" as never },
      { ...entry, disabled: 0 as never },
      { ...entry, digests: null as never },
      { ...entry, digests: { peers: "hash" as never } },
      { ...entry, digests: { peers: Array(3).fill("a".repeat(64)) } },
      { ...entry, digests: { peers: ["a".repeat(63)] } },
      { ...entry, digests: { peers: [], hook: 1 as never } },
    ];
    for (const value of malformed)
      expect(
        matchEntry(
          value,
          key,
          route,
          operation,
          sentence,
          [candidate("target")],
          true,
        ),
      ).toEqual({ hit: false, reason: "corrupt" });
  });
});
