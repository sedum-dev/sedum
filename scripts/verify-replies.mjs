import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const env = { ...process.env, SEDUM_BROWSER_INTEGRATION: "1" };
delete env.TYPESAFE_API_KEY;
delete env.TYPESAFE_BASE_URL;
delete env.TYPESAFE_DEFAULT_MODEL;
delete env.SEDUM_RECORD_REPLIES;
const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    "packages/provider-typesafe/src/fixture-engine.integration.test.ts",
  ],
  { env, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
