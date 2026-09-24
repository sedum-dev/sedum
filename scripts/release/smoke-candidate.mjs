import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCandidate } from "./verify-candidate.mjs";
import { assert } from "./packages.mjs";

const directory = path.resolve(process.argv[2] ?? "release-candidate");
const { manifest } = await verifyCandidate(directory);
const install = await mkdtemp(path.join(tmpdir(), "sedum-candidate-install-"));
execFileSync("npm", ["init", "-y"], { cwd: install, stdio: "pipe" });
execFileSync(
  "npm",
  [
    "install",
    "--ignore-scripts",
    ...manifest.packages.map((entry) => path.join(directory, entry.filename)),
  ],
  { cwd: install, stdio: "pipe" },
);
const output = execFileSync(
  path.join(install, "node_modules/.bin/sedum"),
  ["--version"],
  { cwd: install, encoding: "utf8" },
).trim();
assert(
  output === manifest.packages[0].version,
  `Installed CLI reported ${output}`,
);
console.log(`Clean candidate install works: sedum ${output}`);
