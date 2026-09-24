// Render the golden RunResults to JUnit XML with the built reporter, so the
// junit-summary workflow shows what a real `--reporter junit` run produces.
// Usage: node scripts/junit-sample.mjs <output-directory>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { renderJunit } from "../packages/reporters/dist/index.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: node scripts/junit-sample.mjs <dir>");
const golden = fileURLToPath(
  new URL("../packages/reporters/test-fixtures/golden/", import.meta.url),
);
for (const mode of ["default", "strict"]) {
  const directory = path.join(output, mode);
  await mkdir(directory, { recursive: true });
  for (const name of ["mixed", "clean"]) {
    const result = JSON.parse(
      await readFile(path.join(golden, `${name}.result.json`), "utf8"),
    );
    const xml = renderJunit(result, {
      strict: mode === "strict",
      evidenceDirectory: ".sedum/runs/golden",
    });
    const checked = await readFile(
      path.join(golden, `${name}.${mode}.junit.xml`),
      "utf8",
    );
    if (xml !== checked)
      throw new Error(`${name}.${mode}.junit.xml is stale; rerun the tests.`);
    await writeFile(path.join(directory, `${name}.junit.xml`), xml);
  }
}
