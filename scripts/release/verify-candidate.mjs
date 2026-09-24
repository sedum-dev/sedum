import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { packages, assert } from "./packages.mjs";

export async function verifyCandidate(directory, expectedSha256) {
  const raw = await readFile(path.join(directory, "manifest.json"));
  const manifestSha256 = createHash("sha256").update(raw).digest("hex");
  if (expectedSha256)
    assert(
      manifestSha256 === expectedSha256,
      "Candidate manifest hash mismatch",
    );
  const manifest = JSON.parse(raw);
  assert(manifest.schemaVersion === 1, "Unknown candidate schema version");
  assert(
    /^[0-9a-f]{40}$/.test(manifest.sourceCommit),
    "Invalid candidate source commit",
  );
  assert(/^\d+$/.test(manifest.buildRunId), "Invalid candidate build run ID");
  assert(
    !Number.isNaN(Date.parse(manifest.createdAt)),
    "Invalid candidate creation time",
  );
  assert(
    Array.isArray(manifest.packages) &&
      manifest.packages.length === packages.length,
    "Incomplete candidate package set",
  );
  const version = manifest.packages[0].version;
  for (const [index, entry] of manifest.packages.entries()) {
    assert(
      entry.name === packages[index].name && entry.version === version,
      "Candidate package name or version mismatch",
    );
    assert(
      typeof entry.filename === "string" &&
        /^[a-zA-Z0-9._-]+\.tgz$/.test(entry.filename),
      "Unsafe tarball filename",
    );
    const bytes = await readFile(path.join(directory, entry.filename));
    assert(bytes.length === entry.sizeBytes, `Size mismatch for ${entry.name}`);
    assert(
      createHash("sha256").update(bytes).digest("hex") === entry.sha256,
      `Hash mismatch for ${entry.name}`,
    );
  }
  return { manifest, manifestSha256 };
}

if (process.argv[1]?.endsWith("verify-candidate.mjs")) {
  const directory = path.resolve(process.argv[2] ?? "release-candidate");
  const { manifestSha256 } = await verifyCandidate(directory, process.argv[3]);
  console.log(manifestSha256);
}
