import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedResolver, lexicalResolver } from "./resolvers.mjs";
import { scoreCase, summarize } from "./score.mjs";

const option = (id, gold, name = id) => ({
  id,
  gold,
  tag: "button",
  role: "button",
  name,
  peers: [],
});
const decision = (options, probabilities) => ({ options, probabilities });

describe("scoreCase", () => {
  const offered = [option("a", "gold"), option("b", null, "Other")];

  it("counts acting on a gold element as correct", () => {
    const score = scoreCase(
      { gold: ["gold"] },
      {
        status: "resolved",
        pickedGold: "gold",
        decisions: [decision(offered, { a: 0.9, b: 0.05, none: 0.05 })],
      },
    );
    expect(score).toMatchObject({ outcome: "correct", stage: null });
  });

  it("blames recall when the gold element was never offered", () => {
    const score = scoreCase(
      { gold: ["missing"] },
      {
        status: "unresolved",
        reason: "none",
        decisions: [decision(offered, { a: 0.1, b: 0.1, none: 0.8 })],
      },
    );
    expect(score).toMatchObject({ outcome: "false_reject", stage: "recall" });
  });

  it("separates a ranking miss from a gate rejection", () => {
    const observation = (probabilities) => ({
      status: "unresolved",
      reason: "ambiguous",
      decisions: [decision(offered, probabilities)],
    });
    expect(
      scoreCase({ gold: ["gold"] }, observation({ a: 0.2, b: 0.7, none: 0.1 }))
        .stage,
    ).toBe("rank");
    expect(
      scoreCase(
        { gold: ["gold"] },
        observation({ a: 0.4, b: 0.35, none: 0.25 }),
      ).stage,
    ).toBe("gate");
  });

  it("reports operational failures by their reason", () => {
    const score = scoreCase(
      { gold: ["gold"] },
      { status: "unresolved", reason: "stale", decisions: [] },
    );
    expect(score.stage).toBe("operational:stale");
  });

  it("treats giving up as correct only when the case is unanswerable", () => {
    for (const gold of ["none", "ambiguous"]) {
      expect(
        scoreCase({ gold }, { status: "unresolved", decisions: [] }).outcome,
      ).toBe("correct_abstain");
      expect(
        scoreCase(
          { gold },
          { status: "resolved", pickedGold: "gold", decisions: [] },
        ),
      ).toMatchObject({ outcome: "wrong_action", stage: "gate" });
    }
  });

  it("flags a gold element that looks identical to another option", () => {
    const twins = [
      option("a", "gold", "Pricing"),
      option("b", null, "Pricing"),
    ];
    const score = scoreCase(
      { gold: ["gold"] },
      {
        status: "unresolved",
        reason: "ambiguous",
        decisions: [decision(twins, { a: 0.45, b: 0.45, none: 0.1 })],
      },
    );
    expect(score.indistinguishable).toBe(true);
  });
});

describe("summarize", () => {
  it("computes rates over the right denominators", () => {
    const item = (gold, outcome, tags = []) => ({
      case: { gold, tags },
      score: { outcome, stage: outcome === "correct" ? null : "rank" },
      calls: [],
    });
    const summary = summarize([
      item(["a"], "correct", ["x"]),
      item(["a"], "wrong_action", ["x"]),
      item("none", "correct_abstain"),
      item("ambiguous", "wrong_action"),
    ]);
    expect(summary).toMatchObject({
      successRate: 0.5,
      wrongActionRate: 0.5,
      abstainRate: 0.5,
      stages: { rank: 3 },
      tags: { x: { cases: 2, ok: 1, wrong: 1 } },
    });
  });
});

describe("resolvers", () => {
  const candidates = (ids) => ({
    complete: true,
    options: [
      ...ids.map((id, index) => ({
        kind: "candidate",
        candidate: {
          id,
          tag: "button",
          role: "button",
          name: index === 0 ? "Save" : "Cancel",
          peers: [],
          editable: false,
          disabled: false,
        },
      })),
      { kind: "none", id: "none" },
    ],
  });
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("lexical baseline returns a coherent distribution", async () => {
    const result = await lexicalResolver().choose(
      "click the Save button",
      candidates(["x1", "x2"]),
    );
    const total = Object.values(result.probabilities).reduce((a, b) => a + b);
    expect(total).toBeCloseTo(1);
    expect(result.selection).toEqual({ kind: "candidate", id: "x1" });
  });

  it("replays a recorded reply under new run-local ids", async () => {
    dir = mkdtempSync(join(tmpdir(), "locator-eval-"));
    const file = join(dir, "replies.json");
    let calls = 0;
    const inner = {
      async choose(_sentence, request) {
        calls++;
        const [first, second] = request.options.map((o) =>
          o.kind === "none" ? "none" : o.candidate.id,
        );
        return {
          selection: { kind: "candidate", id: second },
          probabilities: { [first]: 0.1, [second]: 0.8, none: 0.1 },
          confidence: 0.7,
          call: { usage: { inputTokens: 10, outputTokens: 0 } },
        };
      },
    };
    const recorder = cachedResolver(inner, file, { model: "m" });
    await recorder.choose("click Cancel", candidates(["r1", "r2"]));
    recorder.save();

    const replay = cachedResolver(inner, file, { model: "m", offline: true });
    const result = await replay.choose(
      "click Cancel",
      candidates(["n1", "n2"]),
    );
    expect(calls).toBe(1);
    expect(result.selection).toEqual({ kind: "candidate", id: "n2" });
    expect(result.probabilities).toEqual({ n1: 0.1, n2: 0.8, none: 0.1 });
    await expect(
      replay.choose("click Save", candidates(["n1", "n2"])),
    ).rejects.toThrow(/No recorded reply/);
  });
});
