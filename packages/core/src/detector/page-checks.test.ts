import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import { ProviderError, type ProviderCall } from "../provider.js";
import { BugDetector } from "./detector.js";
import type {
  InspectedPage,
  PageInspection,
  PageInspector,
} from "./semantic.js";
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

type FakePage = BrowserPage & {
  shown: string;
  pending: BrowserSignal[];
  settles: number;
};

function fakePage(
  shown: string,
  { url = "https://shop.test/orders?token=secret", title = "Orders" } = {},
): FakePage {
  const page = {
    shown,
    pending: [] as BrowserSignal[],
    settles: 0,
    url,
    closed: false,
    title: async () => title,
    signals: () => ({
      settle: async () => {
        page.settles++;
      },
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
    inspectPage: vi.fn(async ({ text }: InspectedPage) =>
      answer(rules.find(([pattern]) => pattern.test(text))?.[1] ?? {}),
    ),
  } satisfies PageInspector;
}

describe("semantic page checks", () => {
  it("asks once per state and reuses the answer across pages", async () => {
    const model = inspector([[/went wrong/u, { error_message: 0.97 }]]);
    const detector = new BugDetector({ semantic: { inspector: model } });
    const first = await detector.inspectStep(fakePage("Something went wrong"));
    expect(first.detections).toMatchObject([
      { check: "error_message", source: "model", probability: 0.97 },
    ]);
    expect(first.calls).toHaveLength(1);
    // The model sees the path, never the query.
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

  it("checks a state once per page", async () => {
    const model = inspector([[/went wrong/u, { error_message: 0.97 }]]);
    const detector = new BugDetector({ semantic: { inspector: model } });
    const page = fakePage("Something went wrong");
    expect((await detector.inspectStep(page)).detections).toHaveLength(1);
    expect(await detector.inspectStep(page)).toEqual({
      detections: [],
      calls: [],
      inspections: [],
    });
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
      semantic: { inspector: model, stuckMs: 600 },
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

  it("stops asking after a run-wide provider error", async () => {
    const model = {
      inspectPage: vi.fn(async () => {
        throw new ProviderError("authentication", "bad key");
      }),
    };
    const detector = new BugDetector({ semantic: { inspector: model } });
    // Without Jev an exact leak is unconfirmed, so it is not reported.
    expect(
      (await detector.inspectStep(fakePage("Total: $NaN"))).detections,
    ).toEqual([]);
    await detector.inspectStep(fakePage("Another page"));
    expect(model.inspectPage).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed call on the step's receipt with unknown cost", async () => {
    const failing = (error: Error) => ({
      inspectPage: vi.fn(async (): Promise<PageInspection> => {
        throw error;
      }),
    });
    const timedOut = await new BugDetector({
      semantic: {
        inspector: failing(new ProviderError("timeout", "slow", 2)),
      },
    }).inspectStep(fakePage("Orders"));
    expect(timedOut.calls).toHaveLength(1);
    expect(timedOut.calls[0]!.call).toMatchObject({
      attempts: 2,
      totalCostUsd: null,
    });
    // A billed reply that failed validation keeps its real usage and cost.
    const invalid = await new BugDetector({
      semantic: {
        inspector: failing(
          new ProviderError("invalid-response", "bad", 1, call),
        ),
      },
    }).inspectStep(fakePage("Orders"));
    expect(invalid.calls.map((c) => c.call)).toEqual([call]);
    // A request rejected before it was sent cost nothing.
    const unsent = await new BugDetector({
      semantic: {
        inspector: failing(new ProviderError("invalid-input", "too large")),
      },
    }).inspectStep(fakePage("Orders"));
    expect(unsent.calls).toEqual([]);
  });

  it("reports signals raised during the stuck-loading wait on this step", async () => {
    const model = inspector([[/Searching/u, { stuck_loading: 0.9 }]]);
    const detector = new BugDetector({
      semantic: { inspector: model, stuckMs: 600 },
    });
    const page = fakePage("Searching…");
    setTimeout(
      () =>
        page.pending.push({
          kind: "http_error",
          message: "GET https://shop.test/api/search returned 504",
          url: "https://shop.test/api/search",
          status: 504,
        }),
      300,
    );
    const found = await detector.inspectStep(page);
    expect(found.detections.map((d) => d.check)).toEqual([
      "http_error",
      "stuck_loading",
    ]);
    // Requests still in flight after the wait get a second settle.
    expect(page.settles).toBe(2);
  });

  it("settles once when no loading wait ran", async () => {
    const page = fakePage("Orders");
    await new BugDetector({
      semantic: { inspector: inspector([]) },
    }).inspectStep(page);
    expect(page.settles).toBe(1);
  });

  it("clips a long title and path to the request limits", async () => {
    const model = inspector([]);
    const detector = new BugDetector({ semantic: { inspector: model } });
    await detector.inspectStep(
      fakePage("Orders", {
        url: `https://shop.test/${"p".repeat(600)}`,
        title: "🛒".repeat(400),
      }),
    );
    const sent = model.inspectPage.mock.calls[0]![0];
    expect(Array.from(sent.title)).toHaveLength(300);
    expect(Array.from(sent.path)).toHaveLength(512);
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

  it("filters page findings through the allow rules", async () => {
    const model = inspector([[/Results/u, { empty_content: 0.9 }]]);
    const detector = new BugDetector({
      semantic: { inspector: model },
      allow: ["empty_content:Page appears empty"],
    });
    expect(
      (await detector.inspectStep(fakePage("Results"))).detections,
    ).toEqual([]);
  });

  it("does not run in browser mode", async () => {
    expect(
      (await new BugDetector().inspectStep(fakePage("Total: $NaN"))).detections,
    ).toEqual([]);
  });
});
