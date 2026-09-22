import { writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { runResultJsonSchema } from "../dist/index.js";

await writeFile(
  new URL("../dist/run-result.schema.json", import.meta.url),
  `${JSON.stringify(runResultJsonSchema(), null, 2)}\n`,
);
