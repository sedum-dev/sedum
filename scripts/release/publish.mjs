import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyCandidate } from "./verify-candidate.mjs";
import { assert } from "./packages.mjs";

const directory = path.resolve(
  process.env.CANDIDATE_DIR ?? "release-candidate",
);
const { manifest } = await verifyCandidate(
  directory,
  process.env.MANIFEST_SHA256,
);
assert(
  process.env.GITHUB_SHA === manifest.sourceCommit,
  "Publish checkout is not the candidate source commit",
);
assert(
  manifest.packages[0].version.includes("-alpha."),
  "Only alpha candidates may publish through this workflow",
);
for (const entry of manifest.packages) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`,
  );
  assert(
    response.ok || response.status === 404,
    `npm is unavailable for ${entry.name} (HTTP ${response.status})`,
  );
  const file = path.join(directory, entry.filename);
  if (response.ok) {
    const metadata = await response.json();
    const existing = await fetch(metadata.dist.tarball);
    assert(
      existing.ok,
      `Existing npm tarball is unavailable for ${entry.name}`,
    );
    const existingHash = createHash("sha256")
      .update(Buffer.from(await existing.arrayBuffer()))
      .digest("hex");
    assert(
      existingHash === entry.sha256,
      `Existing ${entry.name}@${entry.version} differs from the candidate`,
    );
    console.log(
      `Already published and verified: ${entry.name}@${entry.version}`,
    );
    continue;
  }
  assert(
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex") === entry.sha256,
    `Tarball changed for ${entry.name}`,
  );
  execFileSync(
    "npm",
    [
      "publish",
      file,
      "--access",
      "public",
      "--tag",
      "next",
      "--provenance",
      "--ignore-scripts",
    ],
    { stdio: "inherit" },
  );
}
console.log(
  `Published ${manifest.packages.length} packages at ${manifest.packages[0].version}`,
);
