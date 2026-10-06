import { describe, expect, it } from "vitest";
import {
  buildClassificationRequests,
  buildItemsRequest,
  buildJudgeRequest,
  buildResolverRequest,
} from "./request.js";
import { buildRelevanceRequests } from "./relevance.js";
import type { ResolverCandidates, ResolverCandidate } from "@sedum-dev/core";

const candidate = (id = "save"): ResolverCandidate => ({
  id,
  tag: "button",
  role: "button",
  name: "Save",
  peers: [],
  editable: false,
  disabled: false,
});
const candidates = (items = [candidate()]): ResolverCandidates => ({
  complete: true,
  options: [
    ...items.map((c) => ({ kind: "candidate" as const, candidate: c })),
    { kind: "none", id: "none" },
  ],
});

describe("Clef request limits", () => {
  it("allowlists candidate fields and keeps Unicode limits in code points", () => {
    const input = {
      ...candidate(),
      name: "😀".repeat(120),
      location: "Toolbar",
      url: "private",
      value: "private",
      html: "private",
    };
    const built = buildResolverRequest("😀".repeat(512), candidates([input]));
    expect(built.optionIds).toEqual(["save", "none"]);
    expect(JSON.stringify(built.request)).not.toContain("private");
    expect(built.request.questions.target!.criteria.save).toMatchObject({
      name: input.name,
      location: "Toolbar",
    });
    expect(() =>
      buildResolverRequest("😀".repeat(513), candidates()),
    ).toThrow();
    expect(() =>
      buildResolverRequest(
        "Save",
        candidates([{ ...input, name: input.name + "x" }]),
      ),
    ).toThrow();
  });
  it("rejects incomplete, duplicate, unsafe, and singleton candidate inputs", () => {
    const invalid = [
      { ...candidates(), complete: false },
      { complete: true, options: [{ kind: "none", id: "none" }] },
      candidates([candidate(), candidate()]),
      candidates([candidate("none")]),
      candidates([{ ...candidate(), tag: "<script>" }]),
      candidates([{ ...candidate(), role: "made-up-role" }]),
      candidates([{ ...candidate(), peers: ["a", "b", "c"] }]),
      candidates([{ ...candidate(), peers: ["x".repeat(81)] }]),
    ];
    for (const input of invalid)
      expect(() =>
        buildResolverRequest("Save", input as ResolverCandidates),
      ).toThrow();
    expect(
      buildResolverRequest("Save", {
        complete: true,
        options: ["a", "b"].map((id) => ({
          kind: "candidate",
          candidate: candidate(id),
        })),
      }).optionIds,
    ).toEqual(["a", "b"]);
  });
  it("enforces the existing 128-candidate ceiling and 64 KiB byte ceiling without truncation", () => {
    const items = Array.from({ length: 128 }, (_, i) => candidate(`c${i}`));
    expect(
      buildResolverRequest("Save", candidates(items)).optionIds,
    ).toHaveLength(129);
    expect(() =>
      buildResolverRequest("Save", candidates([...items, candidate("extra")])),
    ).toThrow();
    expect(() =>
      buildResolverRequest(
        "Save",
        candidates(
          items.map((c) => ({
            ...c,
            name: "😀".repeat(120),
            peers: ["😀".repeat(80), "😀".repeat(80)],
          })),
        ),
      ),
    ).toThrow(/64 KiB/);
    expect(() =>
      buildResolverRequest(
        "Save",
        candidates(Array.from({ length: 255 }, (_, i) => candidate(`c${i}`))),
      ),
    ).toThrow(/255/);
  });
  it("rejects incomplete/oversize judge input and only copies allowed text", () => {
    const request = buildJudgeRequest("Saved", {
      complete: true,
      text: "x".repeat(4096),
    });
    expect(Object.keys(request.questions)).toEqual(["holds", "contradicted"]);
    expect(() =>
      buildJudgeRequest("Saved", { complete: false, text: "Saved" }),
    ).toThrow();
    expect(() =>
      buildJudgeRequest("Saved", { complete: true, text: "x".repeat(4097) }),
    ).toThrow();
  });
  it("maps item ids to independent bounded questions", () => {
    const items = [
      { id: "second", text: "Blue" },
      { id: "first", text: "Red" },
    ];
    const built = buildItemsRequest("Choose red", items);
    expect(built.keys).toEqual([
      ["second", "item0"],
      ["first", "item1"],
    ]);
    expect(built.request.state).toEqual({
      sentence: "Choose red",
      item0: "Blue",
      item1: "Red",
    });
    for (const invalid of [
      [],
      items.slice(0, 1),
      [items[0]!, items[0]!],
      [{ id: "a", text: "x".repeat(301) }, items[0]!],
      Array.from({ length: 41 }, (_, i) => ({ id: `i${i}`, text: "item" })),
    ])
      expect(() => buildItemsRequest("Choose red", invalid)).toThrow();
  });
  it("splits complete classification questions by bytes, preserving every sentence and index", () => {
    expect(buildClassificationRequests([])).toEqual([]);
    expect(() => buildClassificationRequests([" "])).toThrow();
    expect(() => buildClassificationRequests(["x".repeat(513)])).toThrow();
    const sentences = Array.from(
      { length: 65 },
      (_, i) => `item ${i} ${"😀".repeat(500)}`,
    );
    const chunks = buildClassificationRequests(sentences);
    expect(chunks.flatMap((c) => c.indexes)).toEqual(
      Array.from({ length: 65 }, (_, i) => i),
    );
    for (const chunk of chunks) {
      expect(Object.keys(chunk.request.questions).length).toBeLessThanOrEqual(
        64,
      );
      expect(
        Buffer.byteLength(JSON.stringify(chunk.request)),
      ).toBeLessThanOrEqual(65536);
      for (const i of chunk.indexes)
        expect(chunk.request.questions[`line${i}`]!.instructions).toContain(
          sentences[i],
        );
    }
  });
  it("splits relevance at 64/65 questions and byte limits without truncating input", () => {
    const tests = Array.from({ length: 65 }, (_, i) => ({
      file: `${i}.test.yaml`,
      source: "click Save",
      modules: [],
    }));
    expect(buildRelevanceRequests("diff", [], "clef")).toEqual([]);
    expect(
      buildRelevanceRequests("diff", tests.slice(0, 64), "clef").map(
        (c) => c.indexes.length,
      ),
    ).toEqual([64]);
    expect(
      buildRelevanceRequests("diff", tests, "clef").map(
        (c) => c.indexes.length,
      ),
    ).toEqual([64, 1]);
    const large = tests
      .slice(0, 3)
      .map((t) => ({ ...t, source: "x".repeat(22000) }));
    expect(
      buildRelevanceRequests("diff", large, "clef").map((c) => c.indexes),
    ).toEqual([[0, 1], [2]]);
    const longDiff = "x".repeat(28000);
    const split = buildRelevanceRequests(longDiff, tests, "clef");
    expect(
      new Set(split.map((chunk) => chunk.chunkIndex)).size,
    ).toBeGreaterThan(1);
    const retained = split.filter((chunk) => chunk.indexes.includes(0));
    expect(
      retained
        .map((chunk) => (chunk.request.state as { diff: string }).diff)
        .join("")
        .split("[sedum line continuation]\n")
        .join(""),
    ).toBe(longDiff);
    for (const chunk of split)
      expect(
        Buffer.byteLength(JSON.stringify(chunk.request)),
      ).toBeLessThanOrEqual(56_000);
  });
});
