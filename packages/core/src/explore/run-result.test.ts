import { describe, expect, it } from "vitest";
import type { ExploreResult } from "./explorer.js";
import { buildExploreRunResult } from "./run-result.js";
import type { TraceEntry } from "./types.js";

const entry = (
  step: number,
  route: string,
  extra: Partial<TraceEntry> = {},
): TraceEntry => ({
  step,
  route,
  state: `s${step}`,
  action: {
    kind: "click",
    target: { role: "link", name: `Go ${step}`, occurrence: 0 },
  },
  why: { options: 3, probability: 0.5 },
  outcome: "acted",
  events: [],
  elapsedMs: 10,
  ...extra,
});

const call = {
  requestedModel: "jev-latest",
  model: "jev-1.13.0",
  attempts: 1,
  usage: { inputTokens: 100, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0.001,
  totalCostUsd: 0.001,
};

const walk: ExploreResult = {
  seed: 7,
  mode: "guided",
  startUrl: "https://shop.test/",
  trace: [
    entry(0, "/customers/12"),
    entry(1, "/customers/34", {
      writes: [{ method: "POST", endpoint: "/api/notes", status: 201 }],
    }),
    entry(2, "/customers/34", {
      events: [
        { kind: "console", message: "boom", signature: "console: boom" },
      ],
      writes: [{ method: "POST", endpoint: "/api/notes", status: 201 }],
    }),
  ],
  failures: [
    { signature: "console: boom", kind: "console", message: "boom", step: 2 },
  ],
  states: 3,
  routes: ["/customers/12", "/customers/34"],
  kinds: { detail: 3 },
  skippedDestructive: ["Log out"],
  writes: { "POST /api/notes": 2 },
  restores: 0,
  archived: 1,
  calls: [call, call],
  measurementCalls: [],
  advisorMs: [80, 100, 120],
  advisorErrors: [],
  excludedKinds: [],
  elapsedMs: 1234.4,
};

describe("exploration result.json", () => {
  it("gives each finding a tag, its page and its test", () => {
    const run = buildExploreRunResult(walk, {
      runId: "r1",
      startedAt: "2026-10-14T00:00:00.000Z",
      requestedSteps: 10,
      safety: "off",
      detect: "browser",
      trace: "trace.jsonl",
      directory: ".sedum/explore/r1",
      frames: new Map([[2, { after: "frames/step-2.jpg" }]]),
      tests: new Map([
        ["console: boom", { notShrunk: "did not reproduce on replay" }],
      ]),
    });
    expect(run.verdict).toBe("findings");
    expect(run.findings).toEqual([
      {
        id: "F1",
        signature: "console: boom",
        kind: "console",
        message: "boom",
        step: 2,
        route: "/customers/34",
        test: { notShrunk: "did not reproduce on replay" },
      },
    ]);
    expect(run.steps).toEqual({ requested: 10, taken: 3 });
    expect(run.durationMs).toBe(1234);
    expect(run.artifacts).toEqual({
      directory: ".sedum/explore/r1",
      trace: "trace.jsonl",
      frames: true,
      tests: [],
    });
  });

  it("sums writes by request with their first step, and folds record ids", () => {
    const run = buildExploreRunResult(walk, {
      runId: "r1",
      startedAt: "",
      requestedSteps: 3,
      safety: "on",
      detect: "browser",
      trace: "trace.jsonl",
      directory: ".",
    });
    expect(run.writes).toEqual([
      { endpoint: "POST /api/notes", count: 2, firstStep: 1 },
    ]);
    expect(run.coverage.routes).toEqual([
      { route: "/customers/:id", visits: 3 },
    ]);
    expect(run.jev).toMatchObject({
      calls: 2,
      inputTokens: 200,
      costUsd: 0.002,
    });
    expect(run.timeline[2]!.signatures).toEqual(["console: boom"]);
    expect(run.artifacts.frames).toBe(false);
  });
});
