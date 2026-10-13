import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DETECTOR_ALLOW,
  DETECTOR_CASES,
} from "../../../fixtures/site/detector-pages.js";
import {
  startFixtureSite,
  type FixtureSite,
} from "../../../fixtures/site/server.js";
import { PlaywrightBrowserDriver } from "./browser-driver.js";
import { NoopClassificationCache } from "./classification-cache.js";
import { BugDetector } from "./detector/detector.js";
import type { PageInspection } from "./detector/semantic.js";
import { runFlow } from "./flow-runner.js";
import type {
  JudgeDecision,
  JudgePageDigest,
  ProviderCall,
  ResolverCandidates,
  ResolverDecision,
} from "./provider.js";
import { RunRecorder } from "./run-recorder.js";
import { executeStep, RuntimeUrl } from "./step-executor.js";

const call: ProviderCall = {
  requestedModel: "fake",
  model: "fake",
  attempts: 1,
  usage: { inputTokens: 1, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

/** Picks the candidate whose name the sentence contains. */
async function choose(
  sentence: string,
  offered: ResolverCandidates,
): Promise<ResolverDecision> {
  const candidates = offered.options.flatMap((option) =>
    option.kind === "candidate" ? [option.candidate] : [],
  );
  const picked = candidates.find((candidate) =>
    sentence.toLowerCase().includes(candidate.name.toLowerCase()),
  );
  const ids = [...candidates.map((candidate) => candidate.id), "none"];
  const selected = picked?.id ?? "none";
  return {
    selection: picked ? { kind: "candidate", id: selected } : { kind: "none" },
    probabilities: Object.fromEntries(
      ids.map((id) => [id, id === selected ? 0.95 : 0.05 / (ids.length - 1)]),
    ),
    confidence: null,
    call,
  };
}

async function holds(
  claim: string,
  digest: JudgePageDigest,
): Promise<JudgeDecision> {
  const fragment = /text\s+(.+?)\s+is\s+shown$/u.exec(claim)?.[1] ?? claim;
  const found = digest.text.includes(fragment);
  return { holds: found ? 0.97 : 0.03, contradicted: found ? 0 : 0.9, call };
}

/** A stand-in for Jev: an error message is "internal error" text. */
const inspector = {
  inspectPage: async ({ text }: { text: string }): Promise<PageInspection> => ({
    probabilities: {
      error_message: /internal error/u.test(text) ? 0.98 : 0.02,
      stuck_loading: 0.02,
      empty_content: 0.05,
      broken_value: 0.05,
    },
    severity: { score: 2.9, confidence: 0.9, probabilities: [] },
    call: { ...call, usage: { inputTokens: 1000, outputTokens: 0 } },
  }),
};

const BROWSER_CHECKS = new Set([
  "console_error",
  "uncaught_exception",
  "unhandled_rejection",
  "http_error",
]);

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "bug detector in a browser",
  () => {
    let site: FixtureSite;
    let root = "";
    beforeAll(async () => {
      site = await startFixtureSite();
      root = await mkdtemp(path.join(tmpdir(), "sedum-detector-"));
    });
    afterAll(async () => {
      await site.close();
      await rm(root, { recursive: true, force: true });
    });

    async function signals(route: string, click = false) {
      const session = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      try {
        const context = await session.newContext({ collectSignals: true });
        const page = await context.newPage();
        await executeStep(page, {
          op: "goto",
          url: new RuntimeUrl([`${site.baseUrl}${route}`]),
        });
        if (click) await page.playwright!().page.click("#act");
        const source = page.signals!()!;
        await source.settle({ maxMs: 1_500 });
        return source.drain();
      } finally {
        await session.close();
      }
    }

    it("collects fetch, XHR, image, and network failures, not only the document", async () => {
      expect(await signals("/detector/fetch-500")).toMatchObject([
        { kind: "http_error", status: 500, resourceType: "fetch" },
      ]);
      expect(await signals("/detector/xhr-404")).toMatchObject([
        { kind: "http_error", status: 404, resourceType: "xhr" },
      ]);
      expect(await signals("/detector/image-404")).toMatchObject([
        { kind: "http_error", status: 404, resourceType: "image" },
      ]);
      expect(await signals("/detector/network-failure")).toMatchObject([
        { kind: "http_error", status: 0 },
      ]);
    }, 60_000);

    it("separates exceptions from rejections and drops a rejection handled later", async () => {
      expect(await signals("/detector/uncaught-exception")).toMatchObject([
        { kind: "uncaught_exception" },
      ]);
      expect(await signals("/detector/unhandled-rejection")).toMatchObject([
        {
          kind: "unhandled_rejection",
          message: "Error: Unexpected response shape",
        },
      ]);
      expect(await signals("/detector/clean-late-handler")).toEqual([]);
      expect(await signals("/detector/clean-warnings")).toEqual([]);
      expect(await signals("/detector/console-error")).toMatchObject([
        { kind: "console_error", message: expect.stringContaining("RECS") },
      ]);
    }, 60_000);

    it("keeps a rejection right after a click on the click's drain", async () => {
      expect(await signals("/detector/click-rejection", true)).toMatchObject([
        { kind: "unhandled_rejection" },
      ]);
    }, 30_000);

    it("raises exactly the labelled browser checks on every fixture case", async () => {
      const session = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      const detector = new BugDetector({ allow: DETECTOR_ALLOW });
      const checks = (found: readonly { check: string }[]) =>
        [...new Set(found.map((detection) => detection.check))].sort();
      // Page checks need Jev; scripts/detector-eval.ts measures those.
      const browserOnly = (labels: readonly string[]) =>
        labels.filter((label) => BROWSER_CHECKS.has(label)).sort();
      try {
        for (const item of DETECTOR_CASES) {
          const context = await session.newContext({ collectSignals: true });
          const page = await context.newPage();
          await executeStep(page, {
            op: "goto",
            url: new RuntimeUrl([`${site.baseUrl}/detector/${item.id}`]),
          });
          const seen: Record<string, string[]> = {
            load: checks((await detector.inspectStep(page)).detections),
          };
          if (item.expect.action) {
            await page.playwright!().page.click("#act");
            seen.action = checks((await detector.inspectStep(page)).detections);
          }
          expect(seen, item.id).toEqual({
            load: browserOnly(item.expect.load),
            ...(item.expect.action
              ? { action: browserOnly(item.expect.action) }
              : {}),
          });
          await context.close();
        }
      } finally {
        await session.close();
      }
    }, 120_000);

    async function run(
      route: string,
      steps: readonly string[],
      detector = new BugDetector(),
    ) {
      const file = path.join(root, `${route.replaceAll("/", "-")}.test.yaml`);
      await writeFile(
        file,
        `url: ${site.baseUrl}${route}\nsteps:\n${steps.map((step) => `  - ${JSON.stringify(step)}`).join("\n")}\n`,
      );
      const recorder = new RunRecorder(async () => undefined, "run");
      await recorder.start();
      const flow = await runFlow(file, {
        repoRoot: root,
        browser: new PlaywrightBrowserDriver(),
        browserKind: "chromium",
        classificationCache: new NoopClassificationCache(),
        provider: { classifyBatch: vi.fn(), choose, holds },
        detector,
        env: {},
        report: {
          recorder,
          privacy: { secretValues: [], sensitiveOrigins: [] },
          evidenceEnabled: false,
          replay: false,
          saveFrame: async () => ({ status: "omitted", reason: "disabled" }),
        },
      });
      await recorder.finish(
        flow.status === "could_not_run"
          ? { code: flow.code, message: flow.message }
          : null,
      );
      return { flow, result: recorder.snapshot };
    }

    it("flags the step that caused a silent save failure without failing it", async () => {
      const { flow, result } = await run("/detector/click-save-500", [
        "click the Save button",
        "verify the text Saved is shown",
      ]);
      expect(flow.status, JSON.stringify(flow)).toBe("passed");
      const [click, verify] = result.tests[0]!.attempts[0]!.steps;
      expect(click).toMatchObject({
        verdict: "passed",
        flags: ["suspected_bug"],
        detections: [
          {
            check: "http_error",
            status: 500,
            url: `${site.baseUrl}/detector/api/fail`,
          },
        ],
      });
      expect(verify!.flags).toEqual([]);
      expect(verify!.detections).toBeUndefined();
      expect(result.tests[0]!.flags).toContain("suspected_bug");
      expect(result.totals.flaggedSteps).toBe(1);
    }, 60_000);

    it("never reports the query of a long URL", async () => {
      const { result } = await run("/detector/long-url-500", [
        "verify the text #1042 is shown",
      ]);
      const [step] = result.tests[0]!.attempts[0]!.steps;
      expect(step!.detections).toHaveLength(1);
      const [detection] = step!.detections!;
      expect(detection!.message).toBe(
        `GET ${site.baseUrl}/detector/api/fail returned 500 Internal Server Error`,
      );
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
    }, 60_000);

    it("records a Jev finding and its call on the step that showed the error", async () => {
      const { flow, result } = await run(
        "/detector/error-after-pay",
        ["click the Pay now button"],
        new BugDetector({ semantic: { inspector } }),
      );
      expect(flow.status, JSON.stringify(flow)).toBe("passed");
      const [pay] = result.tests[0]!.attempts[0]!.steps;
      expect(pay).toMatchObject({
        flags: ["suspected_bug"],
        detections: [
          {
            check: "error_message",
            source: "model",
            probability: 0.98,
            severity: 2.9,
          },
        ],
      });
      expect(pay!.calls.filter((c) => c.purpose === "detector")).toHaveLength(
        1,
      );
    }, 60_000);

    it("flags an uncaught exception on the click that threw, after a clean load", async () => {
      const { flow, result } = await run("/detector/click-exception", [
        "verify the text Canvas Backpack is shown",
        "click the Apply coupon button",
      ]);
      expect(flow.status, JSON.stringify(flow)).toBe("passed");
      const [verify, click] = result.tests[0]!.attempts[0]!.steps;
      expect(verify!.detections).toBeUndefined();
      expect(click!.detections).toEqual([
        {
          check: "uncaught_exception",
          message: "TypeError: Cannot read properties of null (reading 'code')",
          url: `${site.baseUrl}/detector/click-exception`,
        },
      ]);
    }, 60_000);
  },
);
