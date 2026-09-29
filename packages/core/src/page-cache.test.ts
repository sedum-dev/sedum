import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  keyedDigest,
  matchEntry,
  normalizeSignal,
  pageKey,
  stageEntry,
} from "./page-cache.js";
import {
  projectCandidates,
  projectDigest,
  type Candidate,
  type CandidatePage,
} from "./page-protocol.js";

const key = new Uint8Array(32).fill(7);
const route = "https://example.test/items?q=a#one";
const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 1000,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;
const cacheCandidateGenerator = gs.record({
  ref: gs.text({ minSize: 1, maxSize: 16 }),
  name: gs.text({ minSize: 1, maxSize: 24 }),
  peer: gs.text({ minSize: 1, maxSize: 16 }),
  hook: gs.sampledFrom(["cart-action", "save-action", "open-action"]),
});
type GeneratedCacheCandidate = {
  readonly ref: string;
  readonly name: string;
  readonly peer: string;
  readonly hook: string;
};
const candidate = (name: string, peer: string, ref = name): Candidate => ({
  ref,
  tag: "button",
  role: "button",
  name,
  peers: [peer],
  editable: false,
  disabled: false,
  inputType: "",
  signals: { path: "body:0/article:0/button:0", contextComplete: true },
});
const target = candidate("Add to cart", "Camera", "camera");
const eligible = (items: Candidate[], complete = true): CandidatePage => ({
  protocol: 1,
  version: { document: "d", route, revision: 0 },
  total: items.length,
  offset: 0,
  next: null,
  complete,
  candidates: items,
});
function stagedGeneratedCandidate(generated: GeneratedCacheCandidate) {
  const base = candidate(generated.name, generated.peer, generated.ref);
  const target: Candidate = {
    ...base,
    signals: {
      ...base.signals,
      hook: generated.hook,
      contextComplete: false,
    },
  };
  const sentence = `Click ${generated.name}`;
  return {
    target,
    sentence,
    entry: stageEntry(
      key,
      route,
      "click",
      sentence,
      target,
      eligible([target]),
    ),
  };
}

describe("page cache matching", () => {
  propertyTest("staged identity signals match their original target", () => {
    hegel.test((tc) => {
      const generated = tc.draw(cacheCandidateGenerator);
      const { target, sentence, entry } = stagedGeneratedCandidate(generated);
      const matched = matchEntry(
        entry,
        key,
        route,
        "click",
        sentence,
        [target],
        true,
      );
      if (
        !matched.hit ||
        matched.candidate.ref !== target.ref ||
        entry.digests.hook !== keyedDigest(key, generated.hook)
      )
        throw new Error("A staged candidate did not preserve its identity");
    }, propertySettings);
  });
  propertyTest("same-score candidates are rejected as near ties", () => {
    hegel.test((tc) => {
      const generated = tc.draw(cacheCandidateGenerator);
      const { target, sentence, entry } = stagedGeneratedCandidate(generated);
      const result = matchEntry(
        entry,
        key,
        route,
        "click",
        sentence,
        [target, { ...target, ref: `${target.ref}-clone` }],
        true,
      );
      if (result.hit || result.reason !== "near_tie")
        throw new Error("A same-score candidate bypassed the near-tie guard");
    }, propertySettings);
  });
  propertyTest("changed sentences do not reuse staged page identity", () => {
    hegel.test((tc) => {
      const generated = tc.draw(cacheCandidateGenerator);
      const { target, sentence, entry } = stagedGeneratedCandidate(generated);
      const result = matchEntry(
        entry,
        key,
        route,
        "click",
        `${sentence} later`,
        [target],
        true,
      );
      if (result.hit || result.reason !== "target_missing")
        throw new Error("A changed sentence reused the staged page identity");
    }, propertySettings);
  });
  propertyTest("page identity is stable under whitespace normalization", () => {
    hegel.test((tc) => {
      const sentence = tc.draw(gs.text({ minSize: 1, maxSize: 48 }));
      const whitespaceVariant = `\t ${sentence.replaceAll(" ", "  ")} \n`;
      if (
        pageKey(key, route, "click", sentence) !==
        pageKey(key, route, "click", whitespaceVariant)
      )
        throw new Error("Page identity changed under whitespace normalization");
    }, propertySettings);
  });

  it("normalizes NFC and whitespace but preserves case and route components", () => {
    expect(normalizeSignal(" e\u0301  x ")).toBe("é x");
    expect(pageKey(key, route, "click", "Buy  Camera")).toBe(
      pageKey(key, route, "click", "Buy Camera"),
    );
    expect(pageKey(key, route, "click", "Buy Camera")).not.toBe(
      pageKey(key, route, "click", "buy Camera"),
    );
    expect(pageKey(key, route, "click", "Buy Camera")).not.toBe(
      pageKey(key, "https://example.test/items?q=b#one", "click", "Buy Camera"),
    );
    expect(pageKey(key, route, "click", "Buy Camera")).not.toBe(
      pageKey(key, "https://example.test/items?q=a#two", "click", "Buy Camera"),
    );
    expect(() =>
      pageKey(new Uint8Array(4), route, "click", "Buy Camera"),
    ).toThrow("256 bits");
  });
  it("requires the full set and a distinguishing signal", () => {
    const entry = stageEntry(
      key,
      route,
      "click",
      "Buy Camera",
      target,
      eligible([target]),
    );
    expect(JSON.stringify(entry)).not.toContain("Camera");
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        target,
        eligible([target, { ...target, ref: "duplicate" }]),
      ),
    ).toThrow("candidate_not_distinguishable");
    const sharedHook = {
      ...target,
      peers: ["In stock"],
      signals: {
        ...target.signals,
        hook: "cart-action",
        contextComplete: false,
      },
    };
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Click Add to cart",
        sharedHook,
        eligible([sharedHook]),
      ),
    ).not.toThrow();
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        sharedHook,
        eligible([
          sharedHook,
          {
            ...sharedHook,
            ref: "other",
            signals: { ...sharedHook.signals, hook: "other-action" },
          },
        ]),
      ),
    ).toThrow("candidate_not_distinguishable");
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        target,
        eligible([target], false),
      ),
    ).toThrow("candidate_not_distinguishable");
    expect(() =>
      stageEntry(key, route, "click", "Buy Camera", target, {
        ...eligible([target]),
        total: 2,
        next: 1,
      }),
    ).toThrow("candidate_not_distinguishable");
    expect(
      matchEntry(
        entry,
        key,
        route,
        "click",
        "Buy Camera",
        [target, candidate("Add to cart", "Phone", "phone")],
        true,
      ),
    ).toMatchObject({ hit: true, candidate: target });
    expect(
      matchEntry(entry, key, route, "click", "Buy Camera", [target], false),
    ).toEqual({ hit: false, reason: "candidate_set_incomplete" });
    expect(
      matchEntry(
        entry,
        key,
        route,
        "click",
        "Buy Camera",
        [target, { ...target, ref: "clone" }],
        true,
      ),
    ).toEqual({ hit: false, reason: "near_tie" });
    expect(
      matchEntry(
        entry,
        key,
        route,
        "click",
        "Buy Camera",
        [candidate("Add to cart", "Phone")],
        true,
      ),
    ).toEqual({ hit: false, reason: "strong_signal_conflict" });
    expect(
      matchEntry(
        entry,
        key,
        route,
        "click",
        "Buy Camera",
        [target],
        true,
        true,
      ),
    ).toEqual({ hit: false, reason: "target_missing" });
    expect(
      matchEntry(
        { ...entry, matcher: 99 },
        key,
        route,
        "click",
        "Buy Camera",
        [target],
        true,
      ),
    ).toEqual({ hit: false, reason: "matcher_mismatch" });
  });
  it("returns typed misses for incompatible, corrupt, weak, disabled, and absent entries", () => {
    const entry = stageEntry(
      key,
      route,
      "click",
      "Buy Camera",
      target,
      eligible([target]),
    );
    const match = (
      value: typeof entry | undefined,
      candidates: Candidate[] = [target],
    ) => matchEntry(value, key, route, "click", "Buy Camera", candidates, true);
    expect(match(undefined)).toEqual({ hit: false, reason: "absent" });
    expect(match({ ...entry, format: 99 })).toEqual({
      hit: false,
      reason: "format_mismatch",
    });
    expect(match({ ...entry, digests: { peers: ["raw"] } })).toEqual({
      hit: false,
      reason: "corrupt",
    });
    expect(match(entry, [])).toEqual({ hit: false, reason: "target_missing" });
    expect(match(entry, [candidate("Something else", "Phone")])).toEqual({
      hit: false,
      reason: "strong_signal_conflict",
    });
    expect(
      matchEntry(
        entry,
        key,
        "https://example.test/else",
        "click",
        "Buy Camera",
        [target],
        true,
      ),
    ).toEqual({ hit: false, reason: "target_missing" });
    const weak = {
      ...entry,
      digests: { label: entry.digests.label!, peers: [] },
    };
    expect(match(weak)).toEqual({ hit: false, reason: "low_score" });
    const disabled = { ...target, disabled: true };
    expect(match({ ...entry, disabled: true }, [disabled])).toEqual({
      hit: false,
      reason: "not_actionable",
    });
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        {
          ...target,
          peers: ["a".repeat(81)],
        },
        eligible([target]),
      ),
    ).toThrow("bounds");
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        { ...target, role: "token=SECRET" },
        eligible([target]),
      ),
    ).toThrow("bounds");
    expect(() =>
      projectCandidates({
        ...eligible([target]),
        candidates: [{ ...target, role: "token=SECRET" }],
      }),
    ).toThrow("candidate_field_too_large");
    const priceOnly = { ...target, peers: ["$10", "USD"] };
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        priceOnly,
        eligible([priceOnly]),
      ),
    ).toThrow("candidate_not_distinguishable");
    const sharedStatus = { ...target, peers: ["Price: $10 In stock"] };
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        sharedStatus,
        eligible([sharedStatus]),
      ),
    ).toThrow("candidate_not_distinguishable");
    const partialContext = {
      ...target,
      signals: { ...target.signals, contextComplete: false },
    };
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Buy Camera",
        partialContext,
        eligible([partialContext]),
      ),
    ).toThrow("candidate_not_distinguishable");
    const inputButton = {
      ...target,
      tag: "input",
      inputType: "submit",
      name: "Customer token",
    };
    expect(() =>
      stageEntry(
        key,
        route,
        "click",
        "Submit Customer token",
        inputButton,
        eligible([inputButton]),
      ),
    ).toThrow("candidate_not_distinguishable");
  });
});

describe("provider projection", () => {
  const page = (value: Candidate): CandidatePage => ({
    protocol: 1,
    version: { document: "x", route, revision: 0 },
    total: 1,
    offset: 0,
    next: null,
    complete: true,
    candidates: [value],
  });
  it("allowlists only permitted fields and retains allowed secret-looking text", () => {
    const projected = projectCandidates(
      page({ ...target, name: "token=ABC123" }),
    );
    expect(projected[0]).toEqual({
      id: "camera",
      tag: "button",
      role: "button",
      name: "token=ABC123",
      peers: ["Camera"],
      editable: false,
      disabled: false,
    });
    expect(JSON.stringify(projected)).not.toContain("path");
    expect(
      projectDigest({
        protocol: 1,
        version: page(target).version,
        text: "API token ABC123",
        complete: true,
      }),
    ).toBe("API token ABC123");
  });
  it("rejects oversize fields and incomplete content without truncation", () => {
    expect(() =>
      projectCandidates(page({ ...target, name: "a".repeat(121) })),
    ).toThrow("candidate_field_too_large");
    expect(() =>
      projectCandidates(page({ ...target, peers: ["a".repeat(81)] })),
    ).toThrow("candidate_field_too_large");
    expect(() =>
      projectCandidates({ ...page(target), complete: false }),
    ).toThrow("candidate_set_incomplete");
    expect(() =>
      projectCandidates({
        ...page(target),
        candidates: Array(129).fill(target),
      }),
    ).toThrow("candidate_set_incomplete");
    expect(
      projectCandidates(page({ ...target, name: "😀".repeat(120) }))[0]?.name,
    ).toHaveLength(240);
    expect(() =>
      projectDigest({
        protocol: 1,
        version: page(target).version,
        text: "x".repeat(4097),
        complete: true,
      }),
    ).toThrow("digest_incomplete");
  });
});
