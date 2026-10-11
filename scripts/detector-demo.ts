/**
 * Runs the detector fixture flows through the real CLI; live provider calls.
 * Usage: bun scripts/detector-demo.ts [browser|semantic]
 * Writes reports under .amp/in/artifacts/detector/demo.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { startFixtureSite } from "../fixtures/site/server.ts";

const mode = process.argv[2] ?? "semantic";
const project = path.resolve(".amp/in/artifacts/detector/demo");
const cli = path.resolve("packages/cli/dist/cli.js");
const site = await startFixtureSite();
try {
  await rm(project, { recursive: true, force: true });
  await mkdir(project, { recursive: true });
  await cp("fixtures/detector", project, { recursive: true });
  // The existing login, cart, and checkout flows are clean controls.
  await cp("fixtures/modules", path.join(project, "modules"), {
    recursive: true,
  });
  for (const flow of ["ui-login-products", "ui-login-checkout"])
    await cp(
      `fixtures/${flow}.test.yaml`,
      path.join(project, `${flow}.test.yaml`),
    );
  for (const file of await readdir(project))
    if (file.endsWith(".test.yaml")) {
      const target = path.join(project, file);
      const text = await readFile(target, "utf8");
      await writeFile(target, text.replaceAll("__BASE_URL__", site.baseUrl));
    }
  // The fixture site runs in this process, so the CLI must not block it.
  const run = spawn(
    "node",
    [
      cli,
      "run",
      "--detect",
      mode,
      "--reporter",
      "steps,markdown,json",
      "--costs",
    ],
    {
      cwd: project,
      stdio: "inherit",
      // Disposable documented fixture credentials only.
      env: { ...process.env, FIXTURE_PASSWORD: "fixture_password" },
    },
  );
  process.exitCode = await new Promise<number>((resolve) =>
    run.on("close", (code) => resolve(code ?? 1)),
  );
} finally {
  await site.close().catch(() => undefined);
}
