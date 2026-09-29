import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyCandidate } from "./verify-candidate.mjs";
import { assert } from "./packages.mjs";

async function fetchWithRetry(url, maxAttempts = 12, delaySeconds = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
    });
    if (response.ok) {
      return response;
    }
    if (attempt < maxAttempts) {
      console.log(
        `Registry not ready (attempt ${attempt}/${maxAttempts}); retrying in ${delaySeconds} seconds`,
      );
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }
  return null;
}

const directory = path.resolve(
  process.env.CANDIDATE_DIR ?? "release-candidate",
);
const { manifest } = await verifyCandidate(
  directory,
  process.env.MANIFEST_SHA256,
);
for (const entry of manifest.packages) {
  const metadataUrl = `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
  const response = await fetchWithRetry(metadataUrl);
  assert(
    response,
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
  const tarballResponse = await fetchWithRetry(metadata.dist.tarball);
  assert(
    tarballResponse,
    `Published tarball unavailable for ${entry.name}`,
  );
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
