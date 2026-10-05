import { createHash } from "node:crypto";
import { assert } from "./packages.mjs";

function registryUrl(entry) {
  return `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
}

export async function verifyPartialRelease(
  manifest,
  currentVersions,
  fetchRegistry = fetch,
) {
  assert(
    manifest.packages.every(
      (entry) => currentVersions[entry.name] === entry.version,
    ),
    "Current package versions differ from the superseded candidate",
  );

  let published = 0;
  let missing = 0;
  for (const entry of manifest.packages) {
    const response = await fetchRegistry(registryUrl(entry));
    assert(
      response.ok || response.status === 404,
      `npm lookup failed for ${entry.name}@${entry.version} (HTTP ${response.status})`,
    );
    if (response.status === 404) {
      missing++;
      continue;
    }

    const metadata = await response.json();
    assert(
      metadata.name === entry.name && metadata.version === entry.version,
      `Registry metadata differs for ${entry.name}`,
    );
    const tarball = await fetchRegistry(metadata.dist?.tarball);
    assert(tarball.ok, `Registry tarball is unavailable for ${entry.name}`);
    const hash = createHash("sha256")
      .update(Buffer.from(await tarball.arrayBuffer()))
      .digest("hex");
    assert(hash === entry.sha256, `Registry tarball differs for ${entry.name}`);
    published++;
  }

  assert(
    published > 0 && missing > 0,
    "A superseded candidate must repair a partial release",
  );
  return { published, missing };
}
