import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import { ProviderError, type ProviderCall } from "../provider.js";
import { BugDetector } from "./detector.js";
import type { PageInspection, PageInspector } from "./semantic.js";
import type { BrowserSignal } from "./signals.js";

// The page script is replaced by each fake page's current text.
vi.mock("../page-bridge.js", () => ({
  quietPage: vi.fn(async () => ({ quiet: true })),
  visibleText: vi.fn(async (page: FakePage) => page.shown),
}));

const call: ProviderCall = {
  requestedModel: "jev-latest",
  model: "jev-1.13.0",
  attempts: 1,
  usage: { inputTokens: 1000, outputTokens: 0 },
  rate: null,
  successfulResponseCostUsd: 0.000042,
  totalCostUsd: 0.000042,
};

type FakePage = BrowserPage & { shown: string; pending: BrowserSignal[] };

function fakePage(shown: string, signals: BrowserSignal[] = []): FakePage {
  const page = {
    shown,
    pending: signals,
    url: "https://shop.test/orders?token=secret",
    closed: false,
    title: async () => "Orders",
    signals: () => ({
      settle: async () => undefined,
      drain: () => page.pending.splice(0),
    }),
  };
  return page as unknown as FakePage;
}

function answer(
  probabilities: Partial<PageInspection["probabilities"]> = {},
  severity = 0.2,
): PageInspection {
  return {
    probabilities: {
      error_message: 0.02,
      stuck_loading: 0.02,
      empty_content: 0.05,
      broken_value: 0.05,
      ...probabilities,
    },
    severity: { score: severity, confidence: 0.6, probabilities: [] },
    call,
  };
}

/** Answers by matching the page text, like a model would. */
function inspector(
  rules: [RegExp, Partial<PageInspection["probabilities"]>][],
) {
  return {
    inspectPage: vi.fn(async ({ text }: { text: string }) =>
      answer(rules.find(([pattern]) => pattern.test(text))?.[1] ?? {}),
    ),
  } satisfies PageInspector;
}

describe("browser and text checks", () => {
  it("reports drained signals once and filters allow-listed noise", async () => {
    const detector = new BugDetector({ allow: ["http_error:/api/session"] });
    const page = fakePage("Orders #1042", [
      { kind: "console_error", message: "boom", url: "" },
      {
        kind: "http_error",
        message: "GET https://shop.test/api/session returned 401",
        url: "https://shop.test/api/session",
        status: 401,
      },
      {
        kind: "http_error",
        message: "GET https://shop.test/favicon.ico returned 404",
        url: "https://shop.test/favicon.ico",
        status: 404,
      },
    ]);
    const first = await detector.inspectStep(page);
    expect(first.detections.map((d) => d.check)).toEqual(["console_error"]);
    expect((await detector.inspectStep(page)).detections).toEqual([]);
  });

  it("checks text only the first time a page shows a state", async () => {
    const detector = new BugDetector();
    const page = fakePage("Hello, undefined!");
    expect((await detector.inspectStep(page)).detections).toMatchObject([
      { check: "broken_value", source: "text" },
    ]);
    expect((await detector.inspectStep(page)).detections).toEqual([]);
    page.shown = "Hello, Sam!";
    expect((await detector.inspectStep(page)).detections).toEqual([]);
  });

  it("does no work once the run is interrupted", async () => {
    const page = fakePage("Hello, undefined!", [
      { kind: "console_error", message: "boom", url: "" },
    ]);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await new BugDetector().inspectStep(page, { signal: controller.signal }))
        .detections,
    ).toEqual([]);
  });

  it("never throws into a step", async () => {
    const page = fakePage("x");
    page.signals = () => {
      throw new Error("driver gone");
    };
    await expect(new BugDetector().inspectStep(page)).resolves.toEqual({
      detections: [],
      calls: [],
      inspections: [],
    });
  });
});

describe("semantic checks", () => {
  it("asks once per state and reuses the answer across pages", async () => {
    const model = inspector([[/went wrong/u, { error_message: 0.97 }]]);
    const detector = new BugDetector({ semantic: { inspector: model } });
    const first = await detector.inspectStep(fakePage("Something went wrong"));
    expect(first.detections).toMatchObject([
      { check: "error_message", source: "model", probability: 0.97 },
    ]);
    expect(first.calls).toHaveLength(1);
    // Path and query never reach the model beyond the path.
    expect(model.inspectPage.mock.calls[0]![0]).toEqual({
      path: "/orders",
      title: "Orders",
      text: "Something went wrong",
    });
    const second = await detector.inspectStep(fakePage("Something went wrong"));
    expect(second.calls).toEqual([]);
    expect(second.inspections[0]!.cached).toBe(true);
    expect(second.detections).toHaveLength(1);
    expect(model.inspectPage).toHaveBeenCalledTimes(1);
  });

  it("keeps an exact leak only when the model confirms a broken value", async () => {
    const model = inspector([
      [/Hello/u, { broken_value: 0.99 }],
      [/typeof/u, { broken_value: 0.2 }],
    ]);
    const detector = new BugDetector({ semantic: { inspector: model } });
    const leak = await detector.inspectStep(fakePage("Hello, undefined!"));
    // The exact string wins; the model's own broken_value is not repeated.
    expect(leak.detections).toMatchObject([
      { check: "broken_value", source: "text" },
    ]);
    const docs = await detector.inspectStep(
      fakePage('typeof returns "undefined"'),
    );
    expect(docs.detections).toEqual([]);
  });

  it("applies per-check thresholds", async () => {
    const model = inspector([[/Results/u, { empty_content: 0.55 }]]);
    const lenient = new BugDetector({ semantic: { inspector: model } });
    expect(
      (await lenient.inspectStep(fakePage("Results"))).detections,
    ).toMatchObject([{ check: "empty_content" }]);
    const strict = new BugDetector({
      semantic: { inspector: model, thresholds: { empty_content: 0.6 } },
    });
    expect((await strict.inspectStep(fakePage("Results"))).detections).toEqual(
      [],
    );
  });

  it("flags loading only when the page stays unchanged", async () => {
    const model = inspector([[/Loading/u, { stuck_loading: 0.9 }]]);
    const detector = new BugDetector({
      semantic: { inspector: model },
      stuckMs: 600,
    });
    const stuck = await detector.inspectStep(fakePage("Loading…"));
    expect(stuck.detections).toMatchObject([{ check: "stuck_loading" }]);
    expect(stuck.inspections[0]!.waited).toBe("unchanged");

    const page = fakePage("Loading orders");
    setTimeout(() => (page.shown = "Order #1042 shipped"), 300);
    const resolved = await detector.inspectStep(page);
    expect(resolved.detections).toEqual([]);
    expect(resolved.inspections.map((i) => i.waited)).toEqual([
      "changed",
      null,
    ]);
    expect(resolved.calls).toHaveLength(2);
  });

  it("stops asking after a run-wide provider error and keeps text checks", async () => {
    const model = {
      inspectPage: vi.fn(async () => {
        throw new ProviderError("authentication", "bad key");
      }),
    };
    const detector = new BugDetector({ semantic: { inspector: model } });
    expect(
      (await detector.inspectStep(fakePage("Total: $NaN"))).detections,
    ).toMatchObject([{ source: "text" }]);
    await detector.inspectStep(fakePage("Another page"));
    expect(model.inspectPage).toHaveBeenCalledTimes(1);
  });

  it("can require a minimum severity for model findings", async () => {
    const model = {
      inspectPage: vi.fn(async () => answer({ empty_content: 0.8 }, 0.4)),
    };
    const detector = new BugDetector({
      semantic: { inspector: model, thresholds: { minSeverity: 1 } },
    });
    expect(
      (await detector.inspectStep(fakePage("Results"))).detections,
    ).toEqual([]);
  });
});
