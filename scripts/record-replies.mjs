import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

if (process.env.SEDUM_RECORD_REPLIES !== "1" || !process.env.TYPESAFE_API_KEY) {
  process.stderr.write(
    "Recording requires SEDUM_RECORD_REPLIES=1 and TYPESAFE_API_KEY.\n",
  );
  process.exitCode = 2;
} else {
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
    {
      env: { ...process.env, SEDUM_BROWSER_INTEGRATION: "1" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
