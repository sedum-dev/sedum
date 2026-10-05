import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { verifyPartialRelease } from "./partial-release.mjs";

const packages = ["@sedum-dev/core", "sedum-cli"];
const bytes = Object.fromEntries(
  packages.map((name) => [name, Buffer.from(`tarball for ${name}`)]),
);
const manifest = {
  packages: packages.map((name) => ({
    name,
    version: "0.1.0-alpha.9",
    sha256: createHash("sha256").update(bytes[name]).digest("hex"),
  })),
};
const currentVersions = Object.fromEntries(
  packages.map((name) => [name, "0.1.0-alpha.9"]),
);

function registry(statuses, replacements = {}) {
  return async (url) => {
    const name = packages.find((candidate) =>
      url.includes(encodeURIComponent(candidate)),
    );
    if (url.startsWith("https://registry.npmjs.org/")) {
      const status = statuses[name];
      return {
        ok: status === 200,
        status,
        json: async () => ({
          name,
          version: "0.1.0-alpha.9",
          dist: {
            tarball: `https://tarballs.test/${encodeURIComponent(name)}`,
          },
        }),
      };
    }
    const body = replacements[name] ?? bytes[name];
    return {
      ok: true,
      arrayBuffer: async () => body,
    };
  };
}

describe("superseded partial release verification", () => {
  it("accepts exact published bytes with at least one missing package", async () => {
    const result = await verifyPartialRelease(
      manifest,
      currentVersions,
      registry({ "@sedum-dev/core": 200, "sedum-cli": 404 }),
    );
    assert.deepEqual(result, { published: 1, missing: 1 });
  });

  it("rejects a candidate when current package versions advanced", async () => {
    await assert.rejects(
      verifyPartialRelease(
        manifest,
        { ...currentVersions, "sedum-cli": "0.1.0-alpha.10" },
        registry({ "@sedum-dev/core": 200, "sedum-cli": 404 }),
      ),
      /Current package versions differ/,
    );
  });

  it("rejects fully missing and fully published superseded candidates", async () => {
    await assert.rejects(
      verifyPartialRelease(
        manifest,
        currentVersions,
        registry({ "@sedum-dev/core": 404, "sedum-cli": 404 }),
      ),
      /must repair a partial release/,
    );
    await assert.rejects(
      verifyPartialRelease(
        manifest,
        currentVersions,
        registry({ "@sedum-dev/core": 200, "sedum-cli": 200 }),
      ),
      /must repair a partial release/,
    );
  });

  it("rejects published bytes that differ from the candidate", async () => {
    await assert.rejects(
      verifyPartialRelease(
        manifest,
        currentVersions,
        registry(
          { "@sedum-dev/core": 200, "sedum-cli": 404 },
          { "@sedum-dev/core": Buffer.from("different tarball") },
        ),
      ),
      /Registry tarball differs/,
    );
  });
});
