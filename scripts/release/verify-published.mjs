import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { verifyCandidate } from "./verify-candidate.mjs";
import { assert } from "./packages.mjs";

async function fetchWithRetry(url, maxAttempts = 12, delaySeconds = 5) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      headers: { "Cache-Control": "no-cache" },
    });
    if (response.ok) {
      return response;
    }
    lastResponse = response;
    if (attempt < maxAttempts) {
      console.log(
        `Registry not ready (HTTP ${response.status}, attempt ${attempt}/${maxAttempts}); retrying in ${delaySeconds} seconds`,
      );
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }
  throw new Error(
    `Failed to fetch ${url} after ${maxAttempts} attempts (last HTTP ${lastResponse?.status ?? "unknown"})`,
  );
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
  const packument = await (
    await fetchWithRetry(
      `https://registry.npmjs.org/${encodeURIComponent(entry.name)}`,
    )
  ).json();
  assert(
    packument["dist-tags"]?.latest === entry.version,
    `npm latest for ${entry.name} is ${packument["dist-tags"]?.latest}, not ${entry.version}`,
  );
  console.log(`Verified ${entry.name}@${entry.version}`);
}
