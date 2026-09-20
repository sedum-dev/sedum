#!/usr/bin/env node
import { createRequire } from "node:module";
import { runCli } from "./run-cli.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };
const output = runCli(process.argv.slice(2), pkg.version);
process.stdout.write(output.stdout);
process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
