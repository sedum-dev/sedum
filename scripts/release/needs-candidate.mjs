import { readFile, appendFile } from "node:fs/promises";
import { packages, assert } from "./packages.mjs";

const manifests = await Promise.all(
  packages.map(async ({ directory }) =>
    JSON.parse(await readFile(`${directory}/package.json`, "utf8")),
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
let needed = false;
if (version !== "0.0.0") {
  const statuses = await Promise.all(
    packages.map(async ({ name }) => {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
        { method: "HEAD" },
      );
      assert(
        response.status === 200 || response.status === 404,
        `npm lookup failed for ${name}@${version} (HTTP ${response.status})`,
      );
      return response.status;
    }),
  );
  assert(
    statuses.every((status) => status === statuses[0]),
    "Only part of this version is published; release needs triage",
  );
  needed = statuses[0] === 404;
}
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, `release=${needed}\n`);
console.log(
  needed
    ? `Build candidate for unpublished ${version}`
    : `No candidate needed at ${version}`,
);
