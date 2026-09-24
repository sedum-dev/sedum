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
for (const entry of manifest.packages) {
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
  const response = await fetch(metadataUrl, {
    headers: { "Cache-Control": "no-cache" },
  });
  assert(
    response.ok,
    `Registry metadata unavailable for ${entry.name}@${entry.version}`,
  );
  const metadata = await response.json();
  assert(
    metadata.name === entry.name && metadata.version === entry.version,
    "Registry metadata mismatch",
  );
  assert(
    metadata.dist.attestations?.provenance,
    `Provenance is missing for ${entry.name}`,
  );
  const tarballResponse = await fetch(metadata.dist.tarball);
  assert(tarballResponse.ok, `Published tarball unavailable for ${entry.name}`);
  const published = Buffer.from(await tarballResponse.arrayBuffer());
  const candidate = await readFile(path.join(directory, entry.filename));
  assert(
    createHash("sha256").update(published).digest("hex") === entry.sha256,
    `Registry tarball differs for ${entry.name}`,
  );
  assert(
    metadata.dist.integrity ===
      `sha512-${createHash("sha512").update(candidate).digest("base64")}`,
    `Registry integrity differs for ${entry.name}`,
  );
  console.log(`Verified ${entry.name}@${entry.version}`);
}
