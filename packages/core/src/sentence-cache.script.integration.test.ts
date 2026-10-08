import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

const call: ProviderCall = {
  requestedModel: "fixture",
  model: "fixture",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};
async function formFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sentence-script-cache-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<main><p>Ready</p><label>Username<input id="user"></label><label>Password<input id="password" type="password"></label></main>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const file = path.join(root, "values.test.ts");
  const api = new URL("./script-api.ts", import.meta.url).href;
  await writeFile(
    file,
    `import { test, expect, secret } from ${JSON.stringify(api)};
test('values', {url:'/'}, async ({page, ai, env}) => {
  await ai('type {{user}} in the Username field', {user: env.USER});
  await ai('type {{password}} in the Password field', {password: secret(env.PASSWORD)});
  await expect(page.locator('#user')).toHaveValue(env.USER);
  await expect(page.locator('#password')).toHaveValue(env.PASSWORD);
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

function cachedTargets(entries: Map<string, CacheEntry>): CacheStore {
  const cache: CacheStore = {
    key: new Uint8Array(32).fill(11),
    lookup: async (key) =>
      entries.has(key) ? { entry: entries.get(key)! } : { reason: "absent" },
    put: async (key, entry) => {
      entries.set(key, entry);
    },
    invalidate: async (key) => {
      entries.delete(key);
    },
    clear: async () => {
      entries.clear();
    },
  };
  return cache;
}

const chooseTarget = async (sentence: string, offered: ResolverCandidates) => {
  const options = offered.options.filter(
    (option) => option.kind === "candidate",
  );
  const selected = options.find((option) =>
    sentence.includes(option.candidate.name),
  )!.candidate.id;
  return {
    selection: { kind: "candidate" as const, id: selected },
    probabilities: Object.fromEntries([
      ...options.map((option) => [
        option.candidate.id,
        option.candidate.id === selected ? 0.99 : 0.005,
      ]),
      ["none", 0.005],
    ]),
    confidence: null,
    call,
  };
};

async function runValues(
  fixture: Awaited<ReturnType<typeof formFixture>>,
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
  "sentence script cache values and live assertions",
  () => {
    it("uses changed bindings and secret() values on hits and fails a fresh false assertion", async () => {
      const fixture = await formFixture();
      const entries = new Map<string, CacheEntry>();
      const cache = cachedTargets(entries);
      const choose = vi.fn(chooseTarget);
      let assertionHolds = true;
      const holds = vi.fn(async () => ({
        holds: assertionHolds ? 0.99 : 0.01,
        contradicted: assertionHolds ? 0.01 : 0.99,
        call,
      }));
      const run = (id: string, user: string, password: string) =>
        runValues(fixture, cache, { choose, holds }, { id, user, password });
      try {
        expect(
          (await run("cold", "Ada", "old-sensitive-19")).outcome.status,
        ).toBe("passed");
        const warm = await run("warm", "Grace", "new-sensitive-72");
        expect(warm.outcome.status).toBe("passed");
        expect(choose).toHaveBeenCalledTimes(2);
        expect(holds).toHaveBeenCalledTimes(2);
        expect(
          warm.result.tests[0]!.attempts[0]!.steps.slice(0, 2).map(
            (step) => step.locator?.source,
          ),
        ).toEqual(["cache", "cache"]);
        expect(JSON.stringify([...entries.values()])).not.toMatch(
          /Ada|Grace|old-sensitive-19|new-sensitive-72/,
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
        expect(choose).toHaveBeenCalledTimes(2);
        expect(holds.mock.calls.length).toBeGreaterThan(2);
      } finally {
        await fixture.close();
      }
    }, 60000);
  },
);
