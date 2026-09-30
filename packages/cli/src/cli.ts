#!/usr/bin/env node
import { createRequire } from "node:module";
import { runCli } from "./run-cli.js";
import { createInterruptState } from "./interrupts.js";
import { startDeadlineWatchdog } from "./deadline-watchdog.js";
import { describeRejection, RejectionRouter } from "@sedum-dev/core";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
const interrupts = createInterruptState();
let deadlineWatchdog: ReturnType<typeof setTimeout> | undefined;
// A promise a TypeScript test never awaited can reject after its run was
// reported, while the process drains. Say so and fail the exit code rather
// than crash; while a run's router is listening, it owns every rejection.
process.on("unhandledRejection", (reason) => {
  if (RejectionRouter.routing) return;
  process.stderr.write(
    `A promise nobody awaited rejected after the run finished: ${describeRejection(reason)}\nFix: Add \`await\` before the page, expect, API, and ai calls in your tests.\n`,
  );
  process.exitCode = 3;
});
const onSigint = () => interrupts.request("SIGINT");
const onSigterm = () => interrupts.request("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
const output = await runCli(process.argv.slice(2), pkg.version, {
  signal: interrupts.signal,
  onRunCommitted: interrupts.commit,
  onRunDeadline: () => {
    deadlineWatchdog = startDeadlineWatchdog();
  },
  capabilities: {
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    color: process.stdout.isTTY === true && !("NO_COLOR" in process.env),
    ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
  },
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
if (deadlineWatchdog) clearTimeout(deadlineWatchdog);
process.off("SIGINT", onSigint);
process.off("SIGTERM", onSigterm);
if (output.stdout) process.stdout.write(output.stdout);
if (output.stderr) process.stderr.write(output.stderr);
process.exitCode = interrupts.exitCode(output.exitCode);
