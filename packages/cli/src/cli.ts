#!/usr/bin/env node
import { createRequire } from "node:module";
import { runCli } from "./run-cli.js";
import { createInterruptState } from "./interrupts.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
const interrupts = createInterruptState();
const onSigint = () => interrupts.request("SIGINT");
const onSigterm = () => interrupts.request("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
const output = await runCli(process.argv.slice(2), pkg.version, {
  signal: interrupts.signal,
  onRunCommitted: interrupts.commit,
  capabilities: {
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    color: process.stdout.isTTY === true && !("NO_COLOR" in process.env),
    ...(process.stdout.columns ? { columns: process.stdout.columns } : {}),
  },
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
process.off("SIGINT", onSigint);
process.off("SIGTERM", onSigterm);
if (output.stdout) process.stdout.write(output.stdout);
if (output.stderr) process.stderr.write(output.stderr);
process.exitCode = interrupts.exitCode(output.exitCode);
