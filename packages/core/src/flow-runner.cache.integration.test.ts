import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import type { CacheStore } from "./cache-store.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import { pageKey, type CacheEntry } from "./page-cache.js";
import type { ResolverCandidates } from "./provider.js";
import { RunRecorder } from "./run-recorder.js";

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "locator cache through the flow runner",
  () => {
    let server: Server;
    let base = "";
    let root = "";
    let cards = true;
    const chosen: string[] = [];
    beforeAll(async () => {
      root = await mkdtemp(path.join(tmpdir(), "sedum-cache-flow-"));
      server = createServer((request, response) => {
        if (request.url === "/login") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<button id="login" onclick="location.href=\'/checkout\'">Log in</button>',
          );
          return;
        }
        if (request.url === "/checkout") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<button id="place-order" onclick="location.href=\'/chosen?item=order\'">Place order</button>',
          );
          return;
        }
        if (request.url === "/form") {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(
            '<label>Username <input name="username"></label><label>Password <input name="password" type="password"></label>',
          );
          return;
        }
        if (request.url?.startsWith("/chosen?")) {
          chosen.push(
            new URL(request.url, "http://fixture.test").searchParams.get(
              "item",
            ) ?? "",
          );
          response.writeHead(200, { "content-type": "text/html" });
          response.end("<h1>Chosen</h1>");
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          "<!doctype html><html><body><main>" +
            (cards
              ? "<article><h2>Camera</h2><button onclick=\"location.href='/chosen?item=Camera'\">Add to cart</button></article><article><h2>Phone</h2><button onclick=\"location.href='/chosen?item=Phone'\">Add to cart</button></article>"
              : "<article><h2>Unknown</h2><button onclick=\"location.href='/chosen?item=Unknown'\">Add to cart</button></article><article><h2>Phone</h2><button onclick=\"location.href='/chosen?item=Phone'\">Add to cart</button></article>") +
            "</main></body></html>",
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

    it("writes only after action success, skips a warm model call, and reports drift", async () => {
      const file = path.join(root, "cart.test.yaml");
      await writeFile(
        file,
        `url: ${base}/\nsteps:\n  - click Add to cart for Camera\n`,
      );
      const key = new Uint8Array(32).fill(13);
      const entries = new Map<string, CacheEntry>();
      const store: CacheStore = {
        key,
        lookup: async (digest) => {
          const entry = entries.get(digest);
          return entry ? { entry } : { reason: "absent" };
        },
        put: vi.fn(async (digest: string, entry: CacheEntry) => {
          entries.set(digest, entry);
        }),
        invalidate: vi.fn(async (digest: string) => {
          entries.delete(digest);
        }),
        clear: async () => entries.clear(),
      };
      const choose = vi.fn(
        async (_sentence: string, offered: ResolverCandidates) => {
          const candidates = offered.options.filter(
            (option) => option.kind === "candidate",
          );
          const camera = candidates.find((option) =>
            option.candidate.peers.some((peer) => peer.includes("Camera")),
          );
          const selected = camera?.candidate.id ?? "none";
          const ids = [
            ...candidates.map((option) => option.candidate.id),
            "none",
          ];
          return {
            selection:
              selected === "none"
                ? ({ kind: "none" } as const)
                : ({ kind: "candidate", id: selected } as const),
            probabilities: Object.fromEntries(
              ids.map((id) => [
                id,
                id === selected ? 0.8 : 0.2 / (ids.length - 1),
              ]),
            ),
            confidence: null,
            call: {
              requestedModel: "recorded",
              model: "recorded",
              attempts: 1,
              usage: { inputTokens: 10, outputTokens: 2 },
              rate: null,
              successfulResponseCostUsd: 0.002,
              totalCostUsd: 0.002,
            },
          };
        },
      );
      const run = async (id: string) => {
        const recorder = new RunRecorder(async () => undefined, id);
        await recorder.start();
        const flow = await runFlow(file, {
          repoRoot: root,
          browser: new PlaywrightBrowserDriver(),
          classificationCache: new NoopClassificationCache(),
          locatorCache: store,
          provider: {
            classifyBatch: vi.fn(),
            choose,
            holds: vi.fn(),
          },
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
        return { flow, result: recorder.snapshot };
      };
      const cold = await run("cold");
      expect(cold.flow.status).toBe("passed");
      expect(chosen).toEqual(["Camera"]);
      expect(store.put).toHaveBeenCalledTimes(1);
      expect(cold.result.totals.modelCalls).toBe(1);
      expect(cold.result.totals.costUsd).toBe(0.002);
      expect(
        cold.result.tests[0]?.attempts[0]?.steps[0]?.locator?.cache,
      ).toMatchObject({
        outcome: "miss",
        reason: "absent",
        fallbackCalledModel: true,
      });
      const warm = await run("warm");
      expect(warm.flow.status).toBe("passed");
      expect(chosen).toEqual(["Camera", "Camera"]);
      expect(choose).toHaveBeenCalledTimes(1);
      expect(warm.result.totals.modelCalls).toBe(0);
      expect(
        warm.result.tests[0]?.attempts[0]?.steps[0]?.locator,
      ).toMatchObject({
        source: "cache",
        cache: { outcome: "hit", fallbackCalledModel: false },
      });
      cards = false;
      const stale = await run("stale");
      expect(stale.flow.status).toBe("failed");
      expect(choose).toHaveBeenCalledTimes(2);
      expect(chosen).toEqual(["Camera", "Camera"]);
      expect(
        stale.result.tests[0]?.attempts[0]?.steps[0]?.locator?.cache,
      ).toMatchObject({
        outcome: "miss",
        fallbackCalledModel: true,
      });
      expect(
        stale.result.tests[0]?.attempts[0]?.steps[0]?.locator?.source,
      ).toBe("none");
      expect(store.put).toHaveBeenCalledTimes(1);
    }, 15_000);

    it("warms unique login and checkout controls without peer text", async () => {
      const file = path.join(root, "login.test.yaml");
      await writeFile(
        file,
        `url: ${base}/login\nsteps:\n  - click Log in\n  - click Place order\n`,
      );
      const entries = new Map<string, CacheEntry>();
      const store: CacheStore = {
        key: new Uint8Array(32).fill(14),
        lookup: async (digest) =>
          entries.has(digest)
            ? { entry: entries.get(digest)! }
            : { reason: "absent" },
        put: async (digest, entry) => {
          entries.set(digest, entry);
        },
        invalidate: async (digest) => {
          entries.delete(digest);
        },
        clear: async () => {
          entries.clear();
        },
      };
      const choose = vi.fn(
        async (sentence: string, offered: ResolverCandidates) => {
          const candidates = offered.options.filter(
            (option) => option.kind === "candidate",
          );
          const ids = candidates.map((option) => option.candidate.id);
          const wanted = /password/iu.test(sentence)
            ? "password"
            : /username/iu.test(sentence)
              ? "username"
              : null;
          const selected =
            candidates.find(
              (option) => option.candidate.name.toLowerCase() === wanted,
            )?.candidate.id ?? ids[0]!;
          return {
            selection: { kind: "candidate" as const, id: selected },
            probabilities: Object.fromEntries([
              ...ids.map((id) => [
                id,
                id === selected ? 0.9 : 0.1 / Math.max(1, ids.length - 1),
              ]),
              ["none", ids.length === 1 ? 0.1 : 0],
            ]),
            confidence: null,
            call: {
              requestedModel: "recorded",
              model: "recorded",
              attempts: 1,
              usage: { inputTokens: 10, outputTokens: 2 },
              rate: null,
              successfulResponseCostUsd: 0.002,
              totalCostUsd: 0.002,
            },
          };
        },
      );
      const run = async (id: string, scenarioFile = file) => {
        const recorder = new RunRecorder(async () => undefined, id);
        await recorder.start();
        const flow = await runFlow(scenarioFile, {
          repoRoot: root,
          browser: new PlaywrightBrowserDriver(),
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
        if (flow.status !== "passed") throw new Error(JSON.stringify(flow));
        await recorder.finish();
        return { flow, result: recorder.snapshot };
      };
      const cold = await run("login-cold");
      expect(cold.flow.status).toBe("passed");
      expect(cold.result.totals.modelCalls).toBe(2);
      expect(entries.size).toBe(2);
      const warm = await run("login-warm");
      expect(warm.flow.status).toBe("passed");
      expect(warm.result.totals.modelCalls).toBe(0);
      expect(choose).toHaveBeenCalledTimes(2);
      expect(
        warm.result.tests[0]?.attempts[0]?.steps.map(
          (step) => step.locator?.source,
        ),
      ).toEqual(["cache", "cache"]);
      const formFile = path.join(root, "form.test.yaml");
      await writeFile(
        formFile,
        `url: ${base}/form\ndata:\n  user: demo\n  password: secret\nsteps:\n  - type {{user}} in the Username field\n  - type {{password}} in the Password field\n`,
      );
      const formCold = await run("form-cold", formFile);
      expect(formCold.flow.status).toBe("passed");
      expect(formCold.result.totals.modelCalls).toBe(2);
      const formWarm = await run("form-warm", formFile);
      expect(formWarm.flow.status).toBe("passed");
      expect(formWarm.result.totals.modelCalls).toBe(0);
      expect(
        formWarm.result.tests[0]?.attempts[0]?.steps.map(
          (step) => step.locator?.source,
        ),
      ).toEqual(["cache", "cache"]);
      await store.clear();
      const literalA = path.join(root, "literal-a.test.yaml");
      const literalB = path.join(root, "literal-b.test.yaml");
      await writeFile(
        literalA,
        `url: ${base}/form\nsteps:\n  - type "alice" in the Username field\n`,
      );
      await writeFile(
        literalB,
        `url: ${base}/form\nsteps:\n  - type "bob" in the Username field\n`,
      );
      const firstLiteral = await run("literal-a", literalA);
      expect(firstLiteral.flow.status).toBe("passed");
      expect(firstLiteral.result.totals.modelCalls).toBe(1);
      expect([...entries.keys()]).toEqual([
        pageKey(
          store.key!,
          `${base}/form`,
          "fill",
          "type in the Username field",
        ),
      ]);
      expect(JSON.stringify([...entries.values()])).not.toMatch(/alice|bob/u);
      const secondLiteral = await run("literal-b", literalB);
      expect(secondLiteral.flow.status).toBe("passed");
      expect(secondLiteral.result.totals.modelCalls).toBe(0);
    }, 15_000);
  },
);
