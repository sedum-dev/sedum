import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import { BugDetector } from "./detector.js";
import type { BrowserSignal, SignalSettleOptions } from "./signals.js";

vi.mock("../page-bridge.js", () => ({
  quietPage: vi.fn(async () => ({ quiet: true })),
}));

type FakePage = BrowserPage & {
  pending: BrowserSignal[];
  settled: SignalSettleOptions[];
};

function fakePage(signals: BrowserSignal[] = []): FakePage {
  const page = {
    pending: signals,
    settled: [] as SignalSettleOptions[],
    url: "https://shop.test/orders",
    closed: false,
    signals: () => ({
      settle: async (options: SignalSettleOptions) => {
        page.settled.push(options);
      },
      drain: () => page.pending.splice(0),
    }),
  };
  return page as unknown as FakePage;
}

const consoleError: BrowserSignal = {
  kind: "console_error",
  message: "boom",
  url: "",
};

describe("BugDetector", () => {
  it("reports drained signals once and filters allow-listed noise", async () => {
    const detector = new BugDetector({ allow: ["http_error:/api/session"] });
    const page = fakePage([
      consoleError,
      { ...consoleError },
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
      {
        kind: "http_error",
        message: "POST https://shop.test/api/orders returned 500",
        url: "https://shop.test/api/orders",
        status: 500,
      },
    ]);
    expect((await detector.inspectStep(page)).detections).toEqual([
      { check: "console_error", message: "boom" },
      {
        check: "http_error",
        message: "POST https://shop.test/api/orders returned 500",
        url: "https://shop.test/api/orders",
        status: 500,
      },
    ]);
    expect((await detector.inspectStep(page)).detections).toEqual([]);
  });

  it("waits for in-flight requests before reading a step's signals", async () => {
    const page = fakePage();
    await new BugDetector({ settleMs: 900 }).inspectStep(page);
    expect(page.settled).toEqual([{ maxMs: 900 }]);
  });

  it("drains a closed page without waiting", async () => {
    const page = fakePage([consoleError]);
    Object.assign(page, { closed: true });
    expect((await new BugDetector().inspectStep(page)).detections).toHaveLength(
      1,
    );
    expect(page.settled).toEqual([]);
  });

  it("finds nothing on a page opened without signal collection", async () => {
    const page = fakePage([consoleError]);
    page.signals = () => null;
    expect((await new BugDetector().inspectStep(page)).detections).toEqual([]);
  });

  it("does no work once the run is interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    const page = fakePage([consoleError]);
    expect(
      (await new BugDetector().inspectStep(page, { signal: controller.signal }))
        .detections,
    ).toEqual([]);
    expect(page.pending).toHaveLength(1);
  });

  it("never throws into a step", async () => {
    const page = fakePage();
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
