import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runFlow,
  type FlowRunnerDependencies,
  type ResultStep,
} from "@sedum-dev/core";
import { runExitCode } from "./exit-policy.js";

vi.mock("@sedum-dev/provider-typesafe", () => ({
  TypeSafeAdapter: class {},
  ProviderGate: class {
    constructor(readonly options: { concurrency: number }) {}
    close() {}
  },
  DEFAULT_PROVIDER_CONCURRENCY: 4,
}));

const step: ResultStep = {
  id: "step",
  index: 1,
  kind: "verify",
  operation: "verify",
  phase: "steps",
  sentence: "verify",
  detail: "",
  sourceStack: [{ file: "fixture.test.yaml", line: 1, col: 1 }],
  state: "completed",
  verdict: "passed",
  flags: [],
  elapsedMs: 1,
  page: { status: "unavailable", reason: "fixture" },
  locator: null,
  judgement: null,
  observations: [],
  calls: [],
  error: null,
  evidence: { status: "omitted", reason: "fixture" },
  replayFrame: null,
  targetBox: null,
};

type Behavior = (
  file: string,
  dependencies: FlowRunnerDependencies,
) => Promise<"passed" | "failed" | "could_not_run" | "hang">;

const state = vi.hoisted(() => ({
  behavior: undefined as undefined | Behavior,
  active: 0,
  peak: 0,
  envs: [] as Array<Readonly<Record<string, string | undefined>>>,
}));

vi.mock("@sedum-dev/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sedum-dev/core")>();
  return {
    ...actual,
    FileClassificationCache: { load: vi.fn(async () => ({})) },
    PlaywrightBrowserDriver: class {},
    runFlow: vi.fn(
      async (file: string, dependencies: FlowRunnerDependencies) => {
        const report = dependencies.report!;
        const slot = report.slot!;
        state.envs.push(dependencies.env);
        const existing = report.recorder.testAt(slot.ordinal);
        const test = existing?.currentAttempt?.running
          ? existing
          : await report.recorder.beginTest({
              id: `test:${path.basename(file)}`,
              file: path.basename(file),
              ordinal: slot.ordinal,
              ...(slot.lane === undefined ? {} : { lane: slot.lane }),
            });
        state.active++;
        state.peak = Math.max(state.peak, state.active);
        try {
          const outcome =
            (await state.behavior?.(file, dependencies)) ?? "passed";
          if (outcome === "could_not_run")
            return {
              status: "could_not_run" as const,
              file,
              code: "browser-disconnected",
              message: "The browser disconnected during the run.",
            };
          if (outcome === "hang") {
            await new Promise((resolve) =>
              dependencies.signal?.addEventListener("abort", resolve, {
                once: true,
              }),
            );
            return {
              status: "could_not_run" as const,
              file,
              code: "execution_error",
              message: "canceled",
            };
          }
          const attempt = test.currentAttempt!;
          const frame = await report.saveFrame(
            { id: attempt.id, ordinal: attempt.ordinal },
            `${attempt.id}:step:1:evidence`,
            new TextEncoder().encode(`frame ${attempt.id}`),
          );
          await test.addStep({
            ...step,
            evidence: frame,
            id: `${attempt.id}:step:1`,
            ...(outcome === "failed" ? { verdict: "failed" as const } : {}),
          });
          await test.finishTest(outcome);
          return outcome === "passed"
            ? { status: "passed" as const, file }
            : {
                status: "failed" as const,
                file,
                source: { file, line: 1, col: 1 },
              };
        } finally {
          state.active--;
        }
      },
    ),
  };
});

import { executeRunCommand } from "./run-command.js";

let root: string | undefined;
let previous: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  state.behavior = undefined;
  state.active = 0;
  state.peak = 0;
  state.envs = [];
  if (previous) process.chdir(previous);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  previous = undefined;
});

async function project(count: number): Promise<string[]> {
  root = await mkdtemp(path.join(tmpdir(), "sedum-parallel-"));
  previous = process.cwd();
  process.chdir(root);
  const names = Array.from(
    { length: count },
    (_, index) => `t${String(index).padStart(2, "0")}.test.yaml`,
  );
  for (const name of names)
    await writeFile(
      path.join(root, name),
      "url: https://example.test\nsteps: [verify page]\n",
    );
  vi.mocked(runFlow).mockClear();
  return names;
}

const base = { replay: false, evidence: false, sensitiveOrigins: [] };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("parallel sedum run", () => {
  it("runs lanes concurrently yet records tests in selection order", async () => {
    const names = await project(20);
    state.behavior = async (file) => {
      // Later tests finish first, so completion order is reversed.
      const index = names.indexOf(path.basename(file));
      await sleep((names.length - index) * 2);
      return "passed";
    };
    const output = await executeRunCommand({
      ...base,
      paths: names,
      parallel: 4,
    });
    expect(output.diagnostic).toBeNull();
    expect(output.result.verdict).toBe("passed");
    expect(state.peak).toBe(4);
    expect(output.result.tests.map((test) => test.file)).toEqual(names);
    expect(output.result.execution).toEqual({
      parallel: { requested: 4, lanes: 4 },
      shard: null,
      providerConcurrency: 4,
    });
    const lanes = new Set(
      output.result.tests.map((test) => test.attempts[0]!.lane),
    );
    expect(lanes).toEqual(new Set([0, 1, 2, 3]));
    const keys = state.envs.map((env) => env.SEDUM_ATTEMPT_KEY);
    expect(new Set(keys).size).toBe(names.length);
    expect(new Set(state.envs.map((env) => env.SEDUM_PARALLEL_INDEX))).toEqual(
      new Set(["0", "1", "2", "3"]),
    );
    expect(runExitCode(output.result, false)).toBe(0);
  });

  it("defaults to one lane and caps auto at half the cores", async () => {
    const names = await project(6);
    const serial = await executeRunCommand({ ...base, paths: names });
    expect(state.peak).toBe(1);
    expect(serial.result.execution).toMatchObject({
      parallel: { requested: 1, lanes: 1 },
      providerConcurrency: 2,
    });
    state.peak = 0;
    const auto = await executeRunCommand({
      ...base,
      paths: names,
      parallel: "auto",
      availableParallelism: 4,
    });
    expect(auto.result.execution?.parallel).toEqual({
      requested: "auto",
      lanes: 2,
    });
    expect(state.peak).toBeLessThanOrEqual(2);
  });

  it("partitions the selection across shards with no overlap or gaps", async () => {
    const names = await project(20);
    const seen: string[] = [];
    for (let index = 1; index <= 3; index++) {
      const output = await executeRunCommand({
        ...base,
        paths: names,
        parallel: 2,
        shard: { index, count: 3 },
        providerConcurrency: 3,
      });
      expect(output.diagnostic).toBeNull();
      expect(output.result.execution).toMatchObject({
        shard: { index, count: 3, globalSelectedTests: 20 },
        providerConcurrency: 3,
      });
      expect(output.result.totals.selectedTests).toBe(
        output.result.tests.length,
      );
      expect(
        state.envs.every((env) => env.SEDUM_SHARD_INDEX === String(index)),
      ).toBe(true);
      state.envs = [];
      seen.push(...output.result.tests.map((test) => test.file));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(names);
  });

  it("fails an empty shard with a shard-specific diagnostic and exit 3", async () => {
    const names = await project(2);
    const empty: string[] = [];
    for (const index of [1, 2, 3]) {
      const output = await executeRunCommand({
        ...base,
        paths: names,
        shard: { index, count: 3 },
      });
      if (output.result.tests.length === 0) {
        expect(output.diagnostic).toMatchObject({
          code: "empty_shard",
          message: `Shard ${index}/3 has no tests; the selection has 2 tests.`,
          fix: "Use --shard-count 2 or fewer.",
        });
        expect(output.result).toMatchObject({
          state: "error",
          verdict: null,
          error: { code: "empty_shard" },
        });
        expect(runExitCode(output.result, false)).toBe(3);
        empty.push(String(index));
      }
    }
    expect(empty).toHaveLength(1);
  });

  it("still reports no_tests when the whole selection is empty", async () => {
    await project(0);
    await writeFile(path.join(root!, "keep.txt"), "not a test");
    const output = await executeRunCommand({
      ...base,
      paths: [],
      shard: { index: 1, count: 2 },
    });
    expect(output.diagnostic?.code).toBe("no_tests");
  });

  it("stops scheduling after an operational error but lets in-flight tests finish", async () => {
    const names = await project(8);
    state.behavior = async (file) => {
      const index = names.indexOf(path.basename(file));
      if (index === 0) {
        await sleep(5);
        return "could_not_run";
      }
      await sleep(30);
      return "passed";
    };
    const output = await executeRunCommand({
      ...base,
      paths: names,
      parallel: 2,
    });
    expect(output.diagnostic?.code).toBe("browser-disconnected");
    expect(vi.mocked(runFlow).mock.calls.length).toBeLessThan(names.length);
    const second = output.result.tests.find((test) => test.file === names[1]);
    expect(second).toMatchObject({ state: "completed", verdict: "passed" });
    expect(runExitCode(output.result, false)).toBe(3);
  });

  it("retries in the same lane with a fresh attempt key", async () => {
    const names = await project(4);
    const failedOnce = new Set<string>();
    state.behavior = async (file) => {
      if (path.basename(file) === names[2] && !failedOnce.has(file)) {
        failedOnce.add(file);
        return "failed";
      }
      await sleep(2);
      return "passed";
    };
    const output = await executeRunCommand({
      ...base,
      paths: names,
      parallel: 2,
      retries: 1,
    });
    expect(output.result.verdict).toBe("passed");
    const retried = output.result.tests[2]!;
    expect(retried.attempts.map((attempt) => attempt.verdict)).toEqual([
      "failed",
      "passed",
    ]);
    expect(retried.attempts[0]!.lane).toBe(retried.attempts[1]!.lane);
    const retriedKeys = vi
      .mocked(runFlow)
      .mock.calls.filter(([file]) => path.basename(file) === names[2])
      .map(([, dependencies]) => dependencies.env.SEDUM_ATTEMPT_KEY);
    expect(retriedKeys).toHaveLength(2);
    expect(retriedKeys[0]).not.toBe(retriedKeys[1]);
  });

  it("closes every in-flight attempt when the run is interrupted", async () => {
    const names = await project(6);
    const controller = new AbortController();
    state.behavior = async () => "hang";
    const pending = executeRunCommand({
      ...base,
      paths: names,
      parallel: 3,
      signal: controller.signal,
    });
    while (state.active < 3) await sleep(1);
    controller.abort();
    const output = await pending;
    expect(output.diagnostic?.code).toBe("canceled");
    expect(output.result.state).toBe("interrupted");
    expect(output.result.tests).toHaveLength(3);
    for (const test of output.result.tests)
      expect(test.attempts[0]!.state).toBe("interrupted");
    expect(vi.mocked(runFlow)).toHaveBeenCalledTimes(3);
    expect(runExitCode(output.result, false)).toBe(3);
  });

  it("keeps every concurrent attempt's evidence in its own folder with its own bytes", async () => {
    const names = await project(12);
    const failedOnce = new Set<string>();
    state.behavior = async (file) => {
      await sleep(Math.random() * 5);
      if (
        names.indexOf(path.basename(file)) % 3 === 0 &&
        !failedOnce.has(file)
      ) {
        failedOnce.add(file);
        return "failed";
      }
      return "passed";
    };
    const output = await executeRunCommand({
      ...base,
      paths: names,
      parallel: 4,
      retries: 1,
    });
    expect(output.result.verdict).toBe("passed");
    const attempts = output.result.tests.flatMap((test) => test.attempts);
    expect(attempts).toHaveLength(12 + 4);
    const directory = path.dirname(output.artifacts.resultPath);
    const folders = new Set<string>();
    for (const attempt of attempts) {
      const frame = attempt.steps[0]!.evidence;
      expect(frame.status).toBe("captured");
      if (frame.status !== "captured") continue;
      folders.add(path.dirname(frame.path));
      expect(await readFile(path.join(directory, frame.path), "utf8")).toBe(
        `frame ${attempt.id}`,
      );
    }
    expect(folders.size).toBe(attempts.length);
  });
});
