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
// A promise a TypeScript test never awaited can reject outside any run's
// router: while a file loads for `list` or `validate`, or after a run was
// reported. Say so, and make sure the command cannot exit 0 because of it.
let strayRejection = false;
const reportStray = (message: string) => {
  strayRejection = true;
  process.stderr.write(
    `${message}\nFix: Add \`await\` before the page, expect, API, and ai calls in your tests.\n`,
  );
};
process.on("unhandledRejection", (reason) => {
  // While a run's router is listening, it owns every rejection.
  if (RejectionRouter.routing) return;
  reportStray(
    `A promise nobody awaited rejected outside any running test: ${describeRejection(reason)}`,
  );
});
const onSigint = () => interrupts.request("SIGINT");
const onSigterm = () => interrupts.request("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
const output = await runCli(process.argv.slice(2), pkg.version, {
  signal: interrupts.signal,
  onRunCommitted: interrupts.commit,
  onStrayRejection: reportStray,
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
const exitCode = interrupts.exitCode(output.exitCode);
process.exitCode = strayRejection ? Math.max(exitCode, 3) : exitCode;
// A stray rejection can still arrive while the process drains.
process.on("beforeExit", () => {
  if (strayRejection)
    process.exitCode = Math.max(Number(process.exitCode ?? 0), 3);
});
