import { readFile, writeFile } from "node:fs/promises";
import { packages, assert } from "./packages.mjs";

const version = process.argv[2];
assert(
  /^\d+\.\d+\.\d+-alpha\.\d+$/.test(version ?? ""),
  "Expected an alpha version",
);
const sections = [];
for (const { name, directory } of packages) {
  const changelog = await readFile(`${directory}/CHANGELOG.md`, "utf8");
  const lines = changelog.split("\n");
  const start = lines.findIndex(
    (line) =>
      line.startsWith(`## ${version}`) ||
      line.startsWith(`## ${name}@${version}`),
  );
  assert(start >= 0, `Missing ${version} changelog for ${name}`);
  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## "),
  );
  sections.push(
    `## ${name}\n\n${lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join("\n")
      .trim()}`,
  );
}
await writeFile(
  "release-notes.md",
  `# Sedum ${version}\n\n${sections.join("\n\n")}\n`,
);
