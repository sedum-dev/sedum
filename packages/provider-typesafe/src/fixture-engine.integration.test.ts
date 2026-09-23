import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  NoopClassificationCache,
  PlaywrightBrowserDriver,
  ResolvedStepTarget,
  collectCandidates,
  executeStep,
  resolveTarget,
  runFlow,
  verify,
  type BrowserContextSession,
  type BrowserPage,
  type BrowserSession,
} from "@sedum-dev/core";
import {
  startFixtureSite,
  type FixtureSite,
} from "../../../fixtures/site/server.js";
import { FixtureReplies } from "./fixture-replies.js";
import { TypeSafeAdapter } from "./index.js";

const browserIntegration = process.env.SEDUM_BROWSER_INTEGRATION === "1";
const recording = process.env.SEDUM_RECORD_REPLIES === "1";
const replyPath =
  process.env.SEDUM_REPLIES_PATH ??
  fileURLToPath(new URL("../../../fixtures/replies/v1.json", import.meta.url));

describe.skipIf(!browserIntegration)("keyless fixture engine", () => {
  let site: FixtureSite;
  let replies: FixtureReplies;
  let adapter: TypeSafeAdapter;
  let session: BrowserSession;
  let successful = 0;

  beforeAll(async () => {
    if (recording && !process.env.TYPESAFE_API_KEY)
      throw new Error("Recording requires TYPESAFE_API_KEY");
    site = await startFixtureSite();
    replies = await FixtureReplies.load(replyPath, recording);
    adapter = new TypeSafeAdapter({
      ...(recording ? {} : { apiKey: "fixture-key" }),
      fetch: replies.fetch,
    });
    session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
  });

  afterAll(async () => {
    await session?.close();
    await site?.close();
    if (replies && (!recording || successful === 4)) await replies.finish();
  });

  async function fresh(
    url: string,
  ): Promise<{ context: BrowserContextSession; page: BrowserPage }> {
    const context = await session.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(site.baseUrl + url);
    return { context, page };
  }

  async function clickNamed(page: BrowserPage, name: string): Promise<void> {
    const snapshot = await collectCandidates(page, "click");
    const matches = snapshot.candidates.filter(
      (candidate) => candidate.name === name,
    );
    expect(matches).toHaveLength(1);
    const candidate = matches[0]!;
    await executeStep(page, {
      op: "click",
      target: new ResolvedStepTarget({
        ref: candidate.ref,
        version: snapshot.version,
        tag: candidate.tag,
        name: candidate.name,
      }),
    });
  }

  it("runs two flows through one login module and the real provider adapter", async () => {
    const folder = await mkdtemp(join(tmpdir(), "sedum-fixture-flow-"));
    try {
      const fixturesRoot = fileURLToPath(
        new URL("../../../fixtures/", import.meta.url),
      );
      await mkdir(join(folder, "modules"));
      await writeFile(
        join(folder, "modules/ui-login.module.yaml"),
        await readFile(
          join(fixturesRoot, "modules/ui-login.module.yaml"),
          "utf8",
        ),
      );
      for (const name of ["ui-login-products", "ui-login-checkout"]) {
        const file = join(folder, `${name}.test.yaml`);
        const template = await readFile(
          join(fixturesRoot, `${name}.test.yaml`),
          "utf8",
        );
        await writeFile(
          file,
          template.replaceAll("__BASE_URL__", site.baseUrl),
        );
        const result = await runFlow(file, {
          repoRoot: folder,
          browser: new PlaywrightBrowserDriver(),
          provider: adapter,
          classificationCache: new NoopClassificationCache(),
          env: { FIXTURE_PASSWORD: "fixture_password" },
        });
        expect(result).toEqual({ status: "passed", file });
      }
      successful++;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 120_000);

  it("resolves repeated controls and duplicate links by current page context", async () => {
    const { context, page } = await fresh("/login");
    try {
      await page.evaluate("sessionStorage.setItem('signed-in','yes')");
      await page.goto(site.baseUrl + "/products");
      const product = await resolveTarget(page, adapter, {
        operation: "click",
        sentence: "Add to cart for the Canvas Backpack",
      });
      expect(product.kind).toBe("resolved");
      if (product.kind !== "resolved") return;
      await executeStep(page, { op: "click", target: product.target });
      expect(await page.text()).toContain("Canvas Backpack added to cart");
      await page.goto(site.baseUrl + "/duplicate-links");
      const link = await resolveTarget(page, adapter, {
        operation: "click",
        sentence: "Read more about Returns",
      });
      expect(link.kind).toBe("resolved");
      if (link.kind !== "resolved") return;
      await executeStep(page, { op: "click", target: link.target });
      expect(page.url).toBe(site.baseUrl + "/returns");
      successful++;
    } finally {
      await context.close();
    }
  }, 60_000);

  it("judges a deliberately false claim and exercises the classification prompt", async () => {
    const classified = await adapter.classifyBatch([
      "press Enter in the search field",
      "observe the current product count",
    ]);
    expect(classified.answers.map((answer) => answer.op)).toEqual([
      "press",
      "measure",
    ]);
    const { context, page } = await fresh("/returns");
    try {
      const judgment = await verify(
        page,
        adapter,
        "A unicorn appears on the page",
      );
      expect(judgment.verdict).toBe("failed");
      expect(judgment.holds).toBeLessThan(0.6);
      successful++;
    } finally {
      await context.close();
    }
  }, 60_000);

  it("serves delayed evidence and rerenders without duplicating an action", async () => {
    const timeoutCase = await fresh("/slow?delay=1000");
    try {
      await expect(
        verify(timeoutCase.page, adapter, "The page says Ready", {
          observationTimeoutMs: 20,
        }),
      ).rejects.toMatchObject({ code: "observation_timeout" });
      expect(replies.missing).toHaveLength(0);
    } finally {
      await timeoutCase.context.close();
    }
    const { context, page } = await fresh("/slow?delay=50");
    try {
      const ready = await verify(page, adapter, "The page says Ready", {
        observationTimeoutMs: 3_000,
      });
      expect(ready.verdict).toBe("passed");
      await clickNamed(page, "Submit once");
      await vi.waitFor(
        async () => {
          expect(await page.text()).toContain("Saved");
        },
        { timeout: 3_000 },
      );
      expect(await page.evaluate<number>("window.actionCount")).toBe(1);
      await page.goto(site.baseUrl + "/rerender?delay=2000");
      const before = await resolveTarget(page, adapter, {
        operation: "click",
        sentence: "Open record",
      });
      expect(before.kind).toBe("resolved");
      if (before.kind !== "resolved") return;
      await page.evaluate("window.rerenderNow()");
      await expect(
        executeStep(page, { op: "click", target: before.target }),
      ).rejects.toMatchObject({ code: "stale", phase: "pre_dispatch" });
      expect(await page.evaluate<number>("window.actionCount")).toBe(0);
      const after = await resolveTarget(page, adapter, {
        operation: "click",
        sentence: "Open record",
      });
      expect(after.kind).toBe("resolved");
      if (after.kind !== "resolved") return;
      await executeStep(page, { op: "click", target: after.target });
      expect(await page.text()).toContain("Record opened");
      expect(await page.evaluate<number>("window.actionCount")).toBe(1);
      successful++;
    } finally {
      await context.close();
    }
  }, 30_000);
});
