import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { createJiti } from "../../packages/core/node_modules/jiti/lib/jiti.mjs";
import {
  FileClassificationCache,
  PlaywrightBrowserDriver,
  RunRecorder,
  runScriptTest,
} from "../../packages/core/dist/index.js";
import { TypeSafeAdapter } from "../../packages/provider-typesafe/dist/index.js";

const root = process.cwd();
const out = path.resolve(process.argv[2]);
mkdirSync(out); // Protect previous takes and their evidence.
mkdirSync(path.join(out, "node_modules"));
symlinkSync(
  path.join(root, "packages/cli"),
  path.join(out, "node_modules/sedum-cli"),
);
cpSync(path.join(root, "examples/cache-study/tests"), path.join(out, "tests"), {
  recursive: true,
});
const file = path.join(out, "tests/sentences.test.ts");
writeFileSync(
  file,
  readFileSync(file, "utf8").replace(
    'await ai("click the login button");',
    `await ai("click the login button");
  if (env.CACHE_DEMO_CHANGED_ID === "1")
    await page.evaluate("document.querySelector('#add-to-cart-sauce-labs-backpack').id='demo-renamed-backpack'");`,
  ),
);
if (spawnSync("git", ["init", "-q"], { cwd: out }).status !== 0)
  throw new Error("Cannot initialize isolated demo cache");
const jiti = createJiti(import.meta.url);
const { openLocatorCache } = await jiti.import(
  path.join(root, "packages/cli/src/locator-cache-store.ts"),
);
const runs = [];

function recordingBrowser(dir) {
  return {
    async launch(options) {
      const session = await new PlaywrightBrowserDriver().launch(options);
      return {
        async newContext(contextOptions) {
          return session.newContext({
            ...contextOptions,
            recordVideo: { dir, size: { width: 1280, height: 900 } },
          });
        },
        close: () => session.close(),
      };
    },
  };
}

for (const mode of ["cold", "warm", "changed-id"]) {
  const dir = path.join(out, mode);
  mkdirSync(dir);
  const recorder = new RunRecorder(async () => undefined, `demo-${mode}`);
  await recorder.start();
  const classificationCache = await FileClassificationCache.load(
    path.join(out, "classification.json"),
    "jev-1.13.0",
  );
  const outcome = await runScriptTest(file, undefined, {
    repoRoot: out,
    baseUrl: "https://www.saucedemo.com",
    browser: recordingBrowser(dir),
    browserKind: "chromium",
    slowMoMs: 250,
    viewport: { width: 1280, height: 900 },
    classificationCache,
    locatorCache: await openLocatorCache(out, { ciOptIn: true }),
    provider: new TypeSafeAdapter({ model: "jev-1.13.0" }),
    env: {
      ...process.env,
      CACHE_DEMO_CHANGED_ID: mode === "changed-id" ? "1" : "0",
    },
    verifyGraceMs: 1000,
    report: {
      recorder,
      privacy: { secretValues: [], sensitiveOrigins: [] },
      evidenceEnabled: false,
      replay: false,
      saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
    },
  });
  await classificationCache.save();
  await recorder.finish();
  const report = recorder.snapshot;
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(report, null, 2));
  const steps = report.tests.flatMap((test) =>
    test.attempts.flatMap((attempt) => attempt.steps),
  );
  runs.push({
    mode,
    outcome,
    totals: report.totals,
    steps: steps.map((step) => ({
      sentence: step.sentence,
      cache: step.locator?.cache,
      verdict: step.verdict,
    })),
    videos: readdirSync(dir).filter((file) => file.endsWith(".webm")),
  });
  writeFileSync(path.join(out, "summary.json"), JSON.stringify(runs, null, 2));
  console.log(mode, outcome.status, report.totals);
}
