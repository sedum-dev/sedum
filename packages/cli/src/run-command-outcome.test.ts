import { describe, expect, it } from "vitest";
import type { ResolvedProjectConfig } from "./config.js";
import type { RunCommandOptions } from "./run-command.js";
import {
  completedRunConclusion,
  interruptionConclusion,
  selectionConclusion,
} from "./run-command-outcome.js";

const config = {
  projectRoot: "/project",
  configPath: "/project/sedum.config.yaml",
} as ResolvedProjectConfig;
const options = {
  replay: false,
  evidence: false,
  sensitiveOrigins: [],
} as RunCommandOptions;
const problem = {
  file: "tests/broken.test.yaml",
  line: 2,
  col: 3,
  code: "broken",
  message: "broken input",
  fix: "fix it",
};

describe("run command outcome policy", () => {
  it("distinguishes interruption from deadline expiry", () => {
    expect(interruptionConclusion(false)).toMatchObject({
      diagnostic: { code: "canceled" },
      state: "interrupted",
    });
    expect(interruptionConclusion(true)).toMatchObject({
      diagnostic: { code: "run_timeout" },
      state: "error",
    });
  });

  it("prioritizes cancellation, empty shards, bad paths, and empty suites", () => {
    expect(
      selectionConclusion({
        config,
        options,
        files: ["test"],
        globalSelectedTests: 1,
        problems: [],
        aborted: false,
        timedOut: false,
      }),
    ).toBeNull();
    expect(
      selectionConclusion({
        config,
        options,
        files: [],
        globalSelectedTests: 0,
        problems: [problem],
        aborted: true,
        timedOut: false,
      })?.diagnostic.code,
    ).toBe("canceled");
    expect(
      selectionConclusion({
        config,
        options: { ...options, shard: { index: 3, count: 4 } },
        files: [],
        globalSelectedTests: 2,
        problems: [problem],
        aborted: false,
        timedOut: false,
      })?.diagnostic.code,
    ).toBe("empty_shard");
    expect(
      selectionConclusion({
        config,
        options,
        files: [],
        globalSelectedTests: 0,
        problems: [problem],
        aborted: false,
        timedOut: false,
      })?.diagnostic.code,
    ).toBe("discovery_error");
    expect(
      selectionConclusion({
        config,
        options,
        files: [],
        globalSelectedTests: 0,
        problems: [],
        aborted: false,
        timedOut: false,
      })?.diagnostic.code,
    ).toBe("no_tests");
  });

  it("summarizes every generated multiple-error count without hiding the first error", () => {
    const first = {
      code: "provider_error" as const,
      message: "first failure",
      fix: "fix first",
    };
    for (let count = 2; count <= 1_001; count++) {
      expect(completedRunConclusion(first, count, [])).toEqual({
        code: "test_errors",
        message: `${count} tests could not run. First: first failure`,
        fix: "Fix the tests named under needs attention, then rerun them.",
      });
    }
    expect(completedRunConclusion(first, 1, [])).toBe(first);
  });
});
