#!/usr/bin/env node
import { createRequire } from "node:module";
import { runCli } from "./run-cli.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
const controller = new AbortController();
let interrupted: "SIGINT" | "SIGTERM" | null = null;
const onInterrupt = (signal: "SIGINT" | "SIGTERM") => {
  interrupted ??= signal;
  controller.abort();
};
const onSigint = () => onInterrupt("SIGINT");
const onSigterm = () => onInterrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
const output = await runCli(
  process.argv.slice(2),
  pkg.version,
  (progressPath) => {
    process.stdout.write(`progress ${progressPath}\n`);
  },
  controller.signal,
);
process.off("SIGINT", onSigint);
process.off("SIGTERM", onSigterm);
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode =
  interrupted === "SIGINT"
    ? 130
    : interrupted === "SIGTERM"
      ? 143
      : output.exitCode;
