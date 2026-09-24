import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { packages, assert } from "./packages.mjs";

const output = path.resolve(process.env.CANDIDATE_DIR ?? "release-candidate");
const dryRun = process.argv.includes("--dry-run");
const sourceCommit =
  process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? "0".repeat(40);
const buildRunId = process.env.GITHUB_RUN_ID ?? "0";
assert(
  /^[0-9a-f]{40}$/.test(sourceCommit),
  "GITHUB_SHA must be a full commit SHA",
);
assert(/^\d+$/.test(buildRunId), "GITHUB_RUN_ID must be numeric");
assert(
  dryRun || (sourceCommit !== "0".repeat(40) && buildRunId !== "0"),
  "Candidate must be built in CI",
);
await mkdir(output, { recursive: true });
assert(
  (await readdir(output)).length === 0,
  "Candidate directory must be empty",
);

const manifests = await Promise.all(
  packages.map(async ({ directory }) =>
    JSON.parse(await readFile(path.join(directory, "package.json"), "utf8")),
  ),
);
const version = manifests[0].version;
assert(
  manifests.every(
    (pkg, index) =>
      pkg.name === packages[index].name &&
      pkg.version === version &&
      !pkg.private,
  ),
  "Release packages must have the expected names and one public version",
);
assert(
  dryRun || version !== "0.0.0",
  "Unversioned packages cannot become a release candidate",
);

if (!dryRun) {
  for (const { name } of packages) {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
      { method: "HEAD" },
    );
    assert(
      response.status === 404,
      `${name}@${version} is already published or npm is unavailable (HTTP ${response.status})`,
    );
  }
}

const entries = [];
for (const { name, directory } of packages) {
  execFileSync(
    "corepack",
    ["pnpm", "--dir", directory, "pack", "--pack-destination", output],
    { stdio: "pipe" },
  );
  const files = (await readdir(output)).filter(
    (file) =>
      file.endsWith(".tgz") &&
      !entries.some((entry) => entry.filename === file),
  );
  assert(files.length === 1, `Expected one new tarball for ${name}`);
  const filename = files[0];
  const tarball = path.join(output, filename);
  const packed = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  );
  assert(
    packed.name === name && packed.version === version && !packed.private,
    `Packed metadata mismatch for ${name}`,
  );
  assert(
    packed.repository === "https://github.com/sedum-dev/sedum",
    `Packed repository mismatch for ${name}`,
  );
  for (const [dependency, range] of Object.entries(packed.dependencies ?? {})) {
    if (dependency.startsWith("@sedum-dev/"))
      assert(
        range === version,
        `${name} does not depend on candidate ${dependency}@${version}`,
      );
    assert(
      !range.startsWith("workspace:"),
      `${name} contains a workspace dependency`,
    );
  }
  const bytes = await readFile(tarball);
  entries.push({
    name,
    version,
    filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  });
}

const manifest = {
  schemaVersion: 1,
  sourceCommit,
  buildRunId,
  createdAt: new Date().toISOString(),
  packages: entries,
};
await import("node:fs/promises").then(({ writeFile }) =>
  writeFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  ),
);
console.log(`Packed ${entries.length} packages at ${version} into ${output}`);
