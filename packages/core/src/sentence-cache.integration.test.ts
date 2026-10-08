import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import type { CacheStore } from "./cache-store.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import type { CacheEntry } from "./page-cache.js";
import type { ProviderCall, ResolverCandidates } from "./provider.js";
import { RunRecorder } from "./run-recorder.js";

const call: ProviderCall = {
  requestedModel: "recorded",
  model: "recorded",
  attempts: 1,
  usage: { inputTokens: 10, outputTokens: 2 },
  rate: null,
  successfulResponseCostUsd: 0.002,
  totalCostUsd: 0.002,
};

/** Entries cross a JSON boundary, as they do through the worktree store. */
function persistedStore(seed = 31) {
  const files = new Map<string, string>();
  const store: CacheStore = {
    key: new Uint8Array(32).fill(seed),
    lookup: async (digest) => {
      const text = files.get(digest);
      return text
        ? { entry: JSON.parse(text) as CacheEntry }
        : { reason: "absent" };
    },
    put: vi.fn(async (digest: string, entry: CacheEntry) => {
      files.set(digest, JSON.stringify(entry));
    }),
    invalidate: vi.fn(async (digest: string) => {
      files.delete(digest);
    }),
    clear: async () => files.clear(),
  };
  return { store, files };
}

/** Recorded resolver: picks the offered control whose name is `wanted()`. */
function resolver(wanted: () => string) {
  return vi.fn(async (_sentence: string, offered: ResolverCandidates) => {
    const options = offered.options.filter(
      (option) => option.kind === "candidate",
    );
    const selected = options.find(
      (option) => option.candidate.name === wanted(),
    )!.candidate.id;
    const rest = 0.1 / options.length;
    return {
      selection: { kind: "candidate" as const, id: selected },
      probabilities: Object.fromEntries([
        ...options.map((option) => [
          option.candidate.id,
          option.candidate.id === selected ? 0.9 : rest,
        ]),
        ["none", rest],
      ]),
      confidence: null,
      call,
    };
  });
}

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "control-noun sentence recipes through the flow runner",
  () => {
    let server: Server;
    let base = "";
    let root = "";
    const state = { promo: false, link: false, refund: false };
    const chosen: string[] = [];
    const go = (item: string) => `onclick="location.href='/done?item=${item}'"`;
    const pages: Record<string, () => string> = {
      "/checkout": () =>
        `<main><button id="checkout" ${go("checkout")}>Checkout</button>` +
        `<button id="cancel" ${go("cancel")}>Cancel</button>` +
        (state.promo
          ? `<button id="promo" ${go("promo")}>Checkout button</button>`
          : "") +
        (state.link ? `<a href="/done?item=link">Checkout</a>` : "") +
        "</main>",
      "/finish": () =>
        `<main><button id="finish" ${go(state.refund ? "refund" : "order")}>Finish</button></main>`,
    };
    const messages: Record<string, string> = {
      order: "Order placed",
      refund: "Refund issued",
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "sedum-sentence-cache-"));
      server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://fixture.test");
        response.writeHead(200, { "content-type": "text/html" });
        if (url.pathname === "/done") {
          const item = url.searchParams.get("item") ?? "";
          chosen.push(item);
          response.end(`<h1>${messages[item] ?? `Chose ${item}`}</h1>`);
          return;
        }
        response.end(
          `<!doctype html><html><body>${pages[url.pathname]?.() ?? ""}</body></html>`,
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture port missing");
      base = `http://127.0.0.1:${address.port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });

    async function scenario(name: string, url: string, steps: string[]) {
      const file = path.join(root, `${name}.test.yaml`);
      await writeFile(
        file,
        `url: ${base}${url}\nsteps:\n${steps.map((step) => `  - ${step}\n`).join("")}`,
      );
      return file;
    }

    async function run(
      file: string,
      store: CacheStore,
      choose: ReturnType<typeof resolver>,
      id: string,
    ) {
      const recorder = new RunRecorder(async () => undefined, id);
      await recorder.start();
      const flow = await runFlow(file, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        browserKind: "chromium",
        classificationCache: new NoopClassificationCache(),
        locatorCache: store,
        provider: { classifyBatch: vi.fn(), choose, holds: vi.fn() },
        env: {},
        report: {
          recorder,
          privacy: { secretValues: [], sensitiveOrigins: [] },
          evidenceEnabled: false,
          replay: false,
          saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
        },
      });
      await recorder.finish();
      const step = recorder.snapshot.tests[0]?.attempts[0]?.steps[0];
      return { flow, locator: step?.locator };
    }

    function reset(): void {
      Object.assign(state, { promo: false, link: false, refund: false });
      chosen.length = 0;
    }

    it("stages a control named with its role noun and hits it in a fresh context", async () => {
      reset();
      const file = await scenario("checkout", "/checkout", [
        "click the Checkout button",
      ]);
      const { store } = persistedStore();
      const choose = resolver(() => "Checkout");
      const cold = await run(file, store, choose, "cold");
      expect(cold.flow.status).toBe("passed");
      expect(cold.locator?.cache).toMatchObject({
        outcome: "miss",
        reason: "absent",
        fallbackCalledModel: true,
      });
      expect(store.put).toHaveBeenCalledTimes(1);
      const warm = await run(file, store, choose, "warm");
      expect(warm.flow.status).toBe("passed");
      expect(choose).toHaveBeenCalledTimes(1);
      expect(warm.locator).toMatchObject({
        source: "cache",
        confidence: null,
        options: [],
        cache: { outcome: "hit", fallbackCalledModel: false },
      });
      expect(chosen).toEqual(["checkout", "checkout"]);
    }, 30_000);

    it("misses before dispatch when a noun-bearing control appears after staging", async () => {
      reset();
      const file = await scenario("promo", "/checkout", [
        "click the Checkout button",
      ]);
      const { store } = persistedStore(32);
      const choose = resolver(() => "Checkout");
      expect((await run(file, store, choose, "cold")).flow.status).toBe(
        "passed",
      );
      state.promo = true;
      const warm = await run(file, store, choose, "warm");
      expect(warm.locator).toMatchObject({
        source: "model",
        cache: {
          outcome: "miss",
          reason: "context_not_unique",
          fallbackCalledModel: true,
        },
      });
      expect(store.invalidate).toHaveBeenCalledTimes(1);
      expect(choose).toHaveBeenCalledTimes(2);
      expect(store.put).toHaveBeenCalledTimes(1);
      const next = await run(file, store, choose, "next");
      expect(next.locator?.cache).toMatchObject({
        outcome: "miss",
        reason: "not_cacheable",
      });
      expect(store.put).toHaveBeenCalledTimes(1);
      expect(chosen).toEqual(["checkout", "checkout", "checkout"]);
    }, 30_000);

    it.each([
      ["a noun-bearing button", { promo: true }],
      ["a same-name link", { link: true }],
    ])(
      "does not store the bare label beside %s",
      async (_name, page) => {
        reset();
        Object.assign(state, page);
        const file = await scenario("competing", "/checkout", [
          "click the Checkout button",
        ]);
        const { store } = persistedStore(33);
        const choose = resolver(() => "Checkout");
        const cold = await run(file, store, choose, "cold");
        expect(cold.flow.status).toBe("passed");
        expect(cold.locator?.cache).toMatchObject({ reason: "not_cacheable" });
        const warm = await run(file, store, choose, "warm");
        expect(warm.locator?.source).toBe("model");
        expect(store.put).not.toHaveBeenCalled();
        expect(chosen).toEqual(["checkout", "checkout"]);
      },
      30_000,
    );

    it("hits an unchanged-looking control whose handler changed; the retained assertion fails", async () => {
      reset();
      const file = await scenario("finish", "/finish", [
        "click the Finish button",
        'verify "Order placed" appears once',
      ]);
      const { store } = persistedStore(34);
      const choose = resolver(() => "Finish");
      expect((await run(file, store, choose, "cold")).flow.status).toBe(
        "passed",
      );
      state.refund = true;
      const warm = await run(file, store, choose, "warm");
      expect(warm.locator).toMatchObject({
        source: "cache",
        cache: { outcome: "hit" },
      });
      expect(warm.flow.status).toBe("failed");
      expect(choose).toHaveBeenCalledTimes(1);
      expect(chosen).toEqual(["order", "refund"]);
    }, 30_000);
  },
);
