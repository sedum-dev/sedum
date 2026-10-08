import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  cpSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const track = process.argv[2];
if (!["baseline", "poc"].includes(track))
  throw new Error("Expected baseline or poc");
if (process.argv[3] && process.argv[3] !== "sentences")
  throw new Error("This experiment measures sentences only");
const root = path.resolve("../..");
const out = path.resolve(
  process.env.CACHE_STUDY_OUTPUT ??
    path.join(root, ".amp/in/artifacts/sentence-cache"),
);
mkdirSync(out, { recursive: true });
if (existsSync(path.join(out, `${track}-raw.json`)))
  throw new Error(
    "Existing evidence is protected; set CACHE_STUDY_OUTPUT to a fresh directory.",
  );
const createdGit = !existsSync(".git");
if (createdGit && spawnSync("git", ["init", "-q"]).status !== 0)
  throw new Error(
    "Cannot create isolated fixture Git metadata for locator caches",
  );
const runs = [];
for (const fixture of process.argv[3] ? [process.argv[3]] : ["sentences"]) {
  for (let pair = 1; pair <= 3; pair++) {
    rmSync(".sedum", { recursive: true, force: true });
    rmSync(".git/sedum/locator-cache", { recursive: true, force: true });
    for (const temperature of ["cold", "warm"]) {
      const id = `${track}-${fixture}-${pair}-${temperature}`;
      const outputDir = path.join(out, id);
      const localOutput = `.sedum/${id}`;
      const env = { ...process.env };
      delete env.SEDUM_GOAL_REPLAY_DIR;
      delete env.SEDUM_GOAL_REPLAY_MATCH;
      const args = [
        path.join(root, "packages/cli/dist/cli.js"),
        "run",
        `tests/${fixture}.test.ts`,
        "--parallel",
        "1",
        "--retries",
        "0",
        "--locator-cache-ci",
        "--output-dir",
        localOutput,
        "--reporter-dir",
        localOutput,
        "--reporter",
        "json",
        "--costs",
      ];
      const started = performance.now();
      const child = spawnSync(process.execPath, args, {
        env,
        encoding: "utf8",
        timeout: 180_000,
      });
      const wallMs = performance.now() - started;
      writeFileSync(path.join(out, `${id}.stdout.txt`), child.stdout ?? "");
      writeFileSync(path.join(out, `${id}.stderr.txt`), child.stderr ?? "");
      try {
        cpSync(localOutput, outputDir, { recursive: true });
      } catch {
        /* Missing output is handled after preserving subprocess evidence. */
      }
      const jsons = [];
      const scan = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) scan(p);
          else if (entry.name === "result.json") jsons.push(p);
        }
      };
      try {
        scan(outputDir);
      } catch {
        /* Missing output is handled after preserving subprocess evidence. */
      }
      const report = jsons.length
        ? JSON.parse(readFileSync(jsons[0], "utf8"))
        : null;
      const run = {
        id,
        track,
        fixture,
        pair,
        temperature,
        exitCode: child.status,
        signal: child.signal,
        error: child.error?.message,
        wallMs,
        command: [process.execPath, ...args],
        report,
      };
      runs.push(run);
      writeFileSync(
        path.join(out, `${track}-raw.json`),
        JSON.stringify(
          {
            baselineRevision: "3d4eb13e184fc244a71aba3de35447db21d2382d",
            runs,
          },
          null,
          2,
        ),
      );
      console.log(
        id,
        child.status,
        Math.round(wallMs),
        report?.totals?.passedTests,
        jsons[0] ?? child.stderr?.slice(-500),
      );
      if (!report?.totals?.executedTests)
        throw new Error(`Infrastructure failure: ${id}; retained raw evidence`);
    }
  }
}
if (createdGit) rmSync(".git", { recursive: true, force: true });
if (runs.some((run) => run.exitCode !== 0)) process.exitCode = 1;
