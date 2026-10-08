import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import type { CacheStore } from "./cache-store.js";
import type { CacheEntry } from "./page-cache.js";
import type {
  Judge,
  ProviderCall,
  Resolver,
  ResolverCandidates,
} from "./provider.js";
import { RunRecorder } from "./run-recorder.js";
import { runScriptTest } from "./script-runner.js";

const scriptApi = pathToFileURL(
  fileURLToPath(new URL("./script-api.ts", import.meta.url)),
).href;
const call: ProviderCall = {
  requestedModel: "fixture",
  model: "fixture",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

async function checkoutFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sentence-script-cache-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<main><p>Ready</p><label>Username<input id="user"></label>' +
        '<label>Password<input id="password" type="password"></label>' +
        "<button id=\"checkout\" onclick=\"document.querySelector('#status').textContent='Checked out ' + document.querySelector('#user').value\">Checkout</button>" +
        '<button id="cancel">Cancel</button><p id="status"></p></main>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const file = path.join(root, "checkout.test.ts");
  await writeFile(
    file,
    `import { test, expect, secret } from ${JSON.stringify(scriptApi)};
test('checkout', {url:'/'}, async ({page, ai, env}) => {
  await ai('type {{user}} in the Username field', {user: env.USER});
  await ai('type {{password}} in the Password field', {password: secret(env.PASSWORD)});
  await expect(page.locator('#user')).toHaveValue(env.USER);
  await expect(page.locator('#password')).toHaveValue(env.PASSWORD);
  await ai('click the Checkout button');
  await expect(page.locator('#status')).toHaveText('Checked out ' + env.USER);
  await ai('verify the page is Ready');
});`,
  );
  return {
    root,
    file,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function persisted(files: Map<string, string>): CacheStore {
  return {
    key: new Uint8Array(32).fill(11),
    lookup: async (key) =>
      files.has(key)
        ? { entry: JSON.parse(files.get(key)!) as CacheEntry }
        : { reason: "absent" },
    put: async (key, entry) => {
      files.set(key, JSON.stringify(entry));
    },
    invalidate: async (key) => {
      files.delete(key);
    },
    clear: async () => {
      files.clear();
    },
  };
}

const chooseTarget = async (sentence: string, offered: ResolverCandidates) => {
  const options = offered.options.filter(
    (option) => option.kind === "candidate",
  );
  const selected = options.find((option) =>
    sentence.includes(option.candidate.name),
  )!.candidate.id;
  const rest = 0.01 / options.length;
  return {
    selection: { kind: "candidate" as const, id: selected },
    probabilities: Object.fromEntries([
      ...options.map((option) => [
        option.candidate.id,
        option.candidate.id === selected ? 0.99 : rest,
      ]),
      ["none", rest],
    ]),
    confidence: null,
    call,
  };
};

async function runCheckout(
  fixture: Awaited<ReturnType<typeof checkoutFixture>>,
  cache: CacheStore,
  provider: Resolver & Judge,
  input: { id: string; user: string; password: string },
) {
  const recorder = new RunRecorder(async () => undefined, input.id);
  await recorder.start();
  const outcome = await runScriptTest(fixture.file, undefined, {
    repoRoot: fixture.root,
    baseUrl: fixture.baseUrl,
    browser: new PlaywrightBrowserDriver(),
    browserKind: "chromium",
    classificationCache: new NoopClassificationCache(),
    locatorCache: cache,
    provider: { classifyBatch: vi.fn(), ...provider },
    env: { USER: input.user, PASSWORD: input.password },
    verifyGraceMs: 1000,
    report: {
      recorder,
      privacy: { secretValues: [], sensitiveOrigins: [] },
      evidenceEnabled: false,
      replay: false,
      saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
    },
  });
  if (outcome.status === "could_not_run")
    throw new Error(JSON.stringify(outcome));
  await recorder.finish();
  return { outcome, result: recorder.snapshot };
}

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "sentence script cache",
  () => {
    it("hits ai() sentences with current bindings and secrets, and reruns assertions", async () => {
      const fixture = await checkoutFixture();
      const files = new Map<string, string>();
      const cache = persisted(files);
      const choose = vi.fn(chooseTarget);
      let assertionHolds = true;
      const holds = vi.fn(async () => ({
        holds: assertionHolds ? 0.99 : 0.01,
        contradicted: assertionHolds ? 0.01 : 0.99,
        call,
      }));
      const run = (id: string, user: string, password: string) =>
        runCheckout(fixture, cache, { choose, holds }, { id, user, password });
      try {
        expect(
          (await run("cold", "Ada", "old-sensitive-19")).outcome.status,
        ).toBe("passed");
        expect(choose).toHaveBeenCalledTimes(3);
        const warm = await run("warm", "Grace", "new-sensitive-72");
        expect(warm.outcome.status).toBe("passed");
        expect(choose).toHaveBeenCalledTimes(3);
        expect(holds).toHaveBeenCalledTimes(2);
        const steps = warm.result.tests[0]!.attempts[0]!.steps;
        expect(
          steps
            .slice(0, 3)
            .map((step) => [step.locator?.source, step.locator?.confidence]),
        ).toEqual([
          ["cache", null],
          ["cache", null],
          ["cache", null],
        ]);
        expect([...files.values()].join("\n")).not.toMatch(
          /Ada|Grace|old-sensitive-19|new-sensitive-72|Checked out/,
        );
        expect(JSON.stringify(warm.result)).not.toContain("new-sensitive-72");
        expect(JSON.stringify(choose.mock.calls)).not.toMatch(
          /old-sensitive-19|new-sensitive-72/,
        );
        assertionHolds = false;
        expect(
          (await run("false-assertion", "Katherine", "third-sensitive-31"))
            .outcome.status,
        ).toBe("failed");
        expect(choose).toHaveBeenCalledTimes(3);
        expect(holds.mock.calls.length).toBeGreaterThan(2);
      } finally {
        await fixture.close();
      }
    }, 60_000);
  },
);
