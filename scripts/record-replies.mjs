import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

if (process.env.SEDUM_RECORD_REPLIES !== "1" || !process.env.TYPESAFE_API_KEY) {
  process.stderr.write(
    "Recording requires SEDUM_RECORD_REPLIES=1 and TYPESAFE_API_KEY.\n",
  );
  process.exitCode = 2;
} else {
  const committed = fileURLToPath(
    new URL("../fixtures/replies/v1.json", import.meta.url),
  );
  const stagingDirectory = mkdtempSync(join(dirname(committed), ".recording-"));
  const staged = join(stagingDirectory, "v1.json");
  const vitest = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  try {
    const capture = spawnSync(
      process.execPath,
      [
        vitest,
        "run",
        "packages/provider-typesafe/src/fixture-engine.integration.test.ts",
      ],
      {
        env: {
          ...process.env,
          SEDUM_BROWSER_INTEGRATION: "1",
          SEDUM_REPLIES_PATH: staged,
        },
        stdio: "inherit",
      },
    );
    if (capture.error) throw capture.error;
    if (capture.status !== 0) process.exitCode = capture.status ?? 1;
    else {
      const format = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../node_modules/prettier/bin/prettier.cjs",
              import.meta.url,
            ),
          ),
          "--write",
          staged,
        ],
        { stdio: "inherit" },
      );
      if (format.error) throw format.error;
      if (format.status !== 0)
        throw new Error("Could not format staged fixture replies");
      const verify = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./verify-replies.mjs", import.meta.url))],
        {
          env: { ...process.env, SEDUM_REPLIES_PATH: staged },
          stdio: "inherit",
        },
      );
      if (verify.error) throw verify.error;
      if (verify.status !== 0) process.exitCode = verify.status ?? 1;
      else renameSync(staged, committed);
    }
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
