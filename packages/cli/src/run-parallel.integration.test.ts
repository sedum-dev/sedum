import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RunResult } from "@sedum-dev/core";
import {
  startFixtureSite,
  type FixtureSite,
} from "../../../fixtures/site/server.js";
import { FixtureReplies } from "../../provider-typesafe/src/fixture-replies.js";
import { runExitCode } from "./exit-policy.js";

const browserIntegration = process.env.SEDUM_BROWSER_INTEGRATION === "1";
const replyPath = fileURLToPath(
  new URL("../../../fixtures/replies/v1.json", import.meta.url),
);

const transport = vi.hoisted(() => ({
  fetch: undefined as undefined | typeof globalThis.fetch,
}));

// Replay recorded provider replies through the real adapter and shared gate.
vi.mock("@sedum-dev/provider-typesafe", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@sedum-dev/provider-typesafe")>();
  return {
    ...actual,
    TypeSafeAdapter: class extends actual.TypeSafeAdapter {
      constructor(
        options: ConstructorParameters<typeof actual.TypeSafeAdapter>[0] = {},
      ) {
        super({ ...options, apiKey: "fixture-key", fetch: transport.fetch! });
      }
    },
  };
});

import { executeRunCommand } from "./run-command.js";

function overlaps(result: RunResult): boolean {
  const attempts = result.tests.flatMap((test) => test.attempts);
  return attempts.some((a) =>
    attempts.some(
      (b) =>
        a !== b &&
        a.lane !== b.lane &&
        Date.parse(a.startedAt) < Date.parse(b.finishedAt!) &&
        Date.parse(b.startedAt) < Date.parse(a.finishedAt!),
    ),
  );
}

/** Every captured frame is on disk, unique, and in its own attempt's folder. */
async function expectIsolatedFrames(
  output: Awaited<ReturnType<typeof executeRunCommand>>,
): Promise<void> {
  const directory = path.dirname(output.artifacts.resultPath);
  const paths = new Set<string>();
  const folderOwners = new Map<string, string>();
  let replayFrames = 0;
  for (const attempt of output.result.tests.flatMap((test) => test.attempts)) {
    for (const step of attempt.steps) {
      if (step.operation === "type")
        expect(step.replayFrame?.status).toBe("captured");
      for (const frame of [step.replayFrame, step.evidence]) {
        if (frame?.status !== "captured") continue;
        if (frame === step.replayFrame) replayFrames++;
        expect(paths.has(frame.path)).toBe(false);
        paths.add(frame.path);
        const folder = path.dirname(frame.path);
        expect(folderOwners.get(folder) ?? attempt.id).toBe(attempt.id);
        folderOwners.set(folder, attempt.id);
        expect(
          (await readFile(path.join(directory, frame.path))).length,
        ).toBeGreaterThan(0);
      }
    }
  }
  expect(replayFrames).toBeGreaterThan(0);
}

describe.skipIf(!browserIntegration)(
  "parallel runs against the fixture site",
  () => {
    let site: FixtureSite;
    let replies: FixtureReplies;
    let root: string;
    let previous: string;
    let names: string[];

    beforeAll(async () => {
      site = await startFixtureSite();
      replies = await FixtureReplies.load(replyPath, false);
      transport.fetch = replies.fetch as typeof globalThis.fetch;
      root = await mkdtemp(path.join(tmpdir(), "sedum-parallel-suite-"));
      const fixtures = fileURLToPath(
        new URL("../../../fixtures/", import.meta.url),
      );
      await mkdir(path.join(root, "modules"));
      await writeFile(
        path.join(root, "modules/ui-login.module.yaml"),
        await readFile(
          path.join(fixtures, "modules/ui-login.module.yaml"),
          "utf8",
        ),
      );
      names = [];
      for (let index = 0; index < 20; index++) {
        const template =
          index % 2 === 0 ? "ui-login-products" : "ui-login-checkout";
        const name = `suite-${String(index).padStart(2, "0")}.test.yaml`;
        names.push(name);
        await writeFile(
          path.join(root, name),
          (
            await readFile(path.join(fixtures, `${template}.test.yaml`), "utf8")
          ).replaceAll("__BASE_URL__", site.baseUrl),
        );
      }
      process.env.FIXTURE_PASSWORD = "fixture_password";
      previous = process.cwd();
      process.chdir(root);
    });

    afterAll(async () => {
      if (previous) process.chdir(previous);
      delete process.env.FIXTURE_PASSWORD;
      await site?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    const run = (
      extra: Parameters<typeof executeRunCommand>[0] extends infer T
        ? Partial<T>
        : never,
    ) =>
      executeRunCommand({
        paths: names,
        browser: "chromium",
        replay: true,
        evidence: true,
        sensitiveOrigins: [],
        locatorCacheDisabled: true,
        ...extra,
      });

    it("runs a 20-test suite in parallel with the same outcome as a serial run", async () => {
      const serialStarted = performance.now();
      const serial = await run({ parallel: 1 });
      const serialMs = performance.now() - serialStarted;
      const parallelStarted = performance.now();
      const parallel = await run({ parallel: 4, retries: 1 });
      const parallelMs = performance.now() - parallelStarted;
      console.info(
        `20-test fixture suite: serial ${Math.round(serialMs)}ms, --parallel 4 ${Math.round(parallelMs)}ms`,
      );
      expect(replies.missing).toEqual([]);
      for (const output of [serial, parallel]) {
        expect(output.diagnostic).toBeNull();
        expect(output.result.verdict).toBe("passed");
        expect(output.result.tests.map((test) => test.file)).toEqual(names);
        await expectIsolatedFrames(output);
      }
      expect(runExitCode(parallel.result, false)).toBe(
        runExitCode(serial.result, false),
      );
      expect(parallel.result.tests.map((test) => test.verdict)).toEqual(
        serial.result.tests.map((test) => test.verdict),
      );
      expect(parallel.result.execution?.parallel.lanes).toBe(4);
      expect(overlaps(parallel.result)).toBe(true);
    }, 600_000);

    it("splits the suite across three shards with no overlap or gaps", async () => {
      const seen: string[] = [];
      for (let index = 1; index <= 3; index++) {
        const output = await run({ parallel: 2, shard: { index, count: 3 } });
        expect(output.diagnostic).toBeNull();
        expect(output.result.verdict).toBe("passed");
        expect(output.result.execution?.shard).toEqual({
          index,
          count: 3,
          globalSelectedTests: 20,
        });
        await expectIsolatedFrames(output);
        seen.push(...output.result.tests.map((test) => test.file));
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual(names);
    }, 600_000);
  },
);
