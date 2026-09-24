import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver, BrowserSession } from "./browser-driver.js";
import { ReusableBrowserDriver } from "./reusable-browser.js";

function fakeDriver() {
  const sessions: Array<BrowserSession & { close: ReturnType<typeof vi.fn> }> =
    [];
  const driver: BrowserDriver = {
    launch: vi.fn(async () => {
      const session = {
        newContext: vi.fn(async () => ({
          newPage: vi.fn(),
          close: vi.fn(async () => undefined),
        })),
        close: vi.fn(async () => undefined),
      };
      sessions.push(session);
      return session;
    }),
  };
  return { driver, sessions };
}

describe("ReusableBrowserDriver", () => {
  it("launches once per lane and hands out sessions whose close keeps the browser", async () => {
    const { driver, sessions } = fakeDriver();
    const lane = new ReusableBrowserDriver(driver);
    const [first, second] = await Promise.all([
      lane.launch({ browser: "chromium" }),
      lane.launch({ browser: "chromium" }),
    ]);
    await first.newContext({ viewport: { width: 10, height: 10 } });
    await first.close();
    await second.newContext();
    expect(driver.launch).toHaveBeenCalledTimes(1);
    expect(sessions[0]!.newContext).toHaveBeenCalledTimes(2);
    expect(sessions[0]!.close).not.toHaveBeenCalled();
  });

  it("closes the browser on recycle and relaunches on the next attempt", async () => {
    const { driver, sessions } = fakeDriver();
    const lane = new ReusableBrowserDriver(driver);
    await lane.recycle();
    await lane.launch();
    await lane.recycle();
    expect(sessions[0]!.close).toHaveBeenCalledTimes(1);
    await lane.launch();
    expect(driver.launch).toHaveBeenCalledTimes(2);
  });

  it("retries a launch after a failed one", async () => {
    const session = {
      newContext: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const driver: BrowserDriver = {
      launch: vi
        .fn()
        .mockRejectedValueOnce(new Error("launch failed"))
        .mockResolvedValueOnce(session),
    };
    const lane = new ReusableBrowserDriver(driver);
    await expect(lane.launch()).rejects.toThrow("launch failed");
    await expect(lane.launch()).resolves.toBeDefined();
    expect(driver.launch).toHaveBeenCalledTimes(2);
  });
});
