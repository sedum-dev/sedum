import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launch, executablePath } = vi.hoisted(() => ({
  launch: vi.fn(),
  executablePath: vi.fn(),
}));
const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("playwright-core", () => ({
  chromium: { launch, executablePath },
}));
vi.mock("node:child_process", () => ({ spawnSync }));

import {
  BrowserDriverError,
  PlaywrightBrowserDriver,
  installChromium,
} from "./browser-driver.js";

class FakePage extends EventEmitter {
  private currentUrl = "about:blank";
  private isClosedValue = false;
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
    return null;
  });
  readonly waitForLoadState = vi.fn(async () => undefined);
  readonly innerText = vi.fn(async () => "fixture page");

  url(): string {
    return this.currentUrl;
  }

  isClosed(): boolean {
    return this.isClosedValue;
  }

  async close(): Promise<void> {
    this.isClosedValue = true;
    this.emit("close");
  }

  locator(): { innerText: () => Promise<string> } {
    return { innerText: this.innerText };
  }

  async evaluate(): Promise<string> {
    return "evaluated";
  }
}

class FakeContext extends EventEmitter {
  readonly page = new FakePage();

  async newPage(): Promise<FakePage> {
    return this.page;
  }

  async close(): Promise<void> {
    this.emit("close");
  }
}

class FakeBrowser extends EventEmitter {
  readonly context = new FakeContext();

  async newContext(): Promise<FakeContext> {
    return this.context;
  }

  async close(): Promise<void> {
    this.emit("disconnected");
  }
}

describe("PlaywrightBrowserDriver", () => {
  beforeEach(() => {
    launch.mockReset();
    executablePath.mockReset();
    spawnSync.mockReset();
    executablePath.mockReturnValue(process.execPath);
  });

  it("does not fall back after a non-missing Chrome launch failure", async () => {
    launch.mockRejectedValue(
      new Error("Chrome was rejected by enterprise policy"),
    );

    await expect(new PlaywrightBrowserDriver().launch()).rejects.toMatchObject({
      code: "browser-launch-failed",
    });
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith({
      channel: "chrome",
      headless: true,
      slowMo: 0,
    });
  });

  it("falls back to matching managed Chromium when Chrome is absent", async () => {
    const browser = new FakeBrowser();
    launch.mockRejectedValueOnce(
      new Error("Executable doesn't exist at channel chrome"),
    );
    launch.mockResolvedValueOnce(browser);

    const session = await new PlaywrightBrowserDriver().launch({
      headless: false,
      slowMoMs: 20,
    });

    expect(session).toBeDefined();
    expect(launch).toHaveBeenNthCalledWith(2, { headless: false, slowMo: 20 });
  });

  it("reports a direct installation fix when neither browser is available", async () => {
    executablePath.mockReturnValue("/path/that/does/not/exist");
    launch.mockRejectedValue(
      new Error("Executable doesn't exist at channel chrome"),
    );

    await expect(new PlaywrightBrowserDriver().launch()).rejects.toMatchObject({
      code: "browser-missing",
      message: expect.stringContaining("sedum browsers install chromium"),
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("normalizes managed-browser launch failures", async () => {
    executablePath.mockReturnValue(process.execPath);
    launch.mockRejectedValueOnce(
      new Error("Executable doesn't exist at channel chrome"),
    );
    launch.mockRejectedValueOnce(
      new Error("managed browser executable doesn't exist"),
    );
    await expect(new PlaywrightBrowserDriver().launch()).rejects.toMatchObject({
      code: "browser-missing",
    });

    launch.mockReset();
    launch.mockRejectedValueOnce(
      new Error("Executable doesn't exist at channel chrome"),
    );
    launch.mockRejectedValueOnce(new Error("managed browser was rejected"));
    await expect(new PlaywrightBrowserDriver().launch()).rejects.toMatchObject({
      code: "browser-launch-failed",
    });
  });

  it("keeps browser objects behind Sedum-owned session and page handles", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);

    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext({
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();

    expect(await page.goto("http://127.0.0.1:4173")).toEqual({
      url: "http://127.0.0.1:4173",
    });
    expect(await page.text()).toBe("fixture page");
    expect(await page.settle()).toMatchObject({ settled: true });
    expect(
      await page.evaluate<string>("document.title", { value: "fixture" }),
    ).toBe("evaluated");
    expect(page.closed).toBe(false);

    await context.close();
    await session.close();
  });

  it("rejects operations after the page is closed", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext();
    const page = await context.newPage();
    await page.close();

    await expect(page.goto("http://example.test")).rejects.toMatchObject({
      code: "page-closed",
    });
    await expect(page.settle()).rejects.toMatchObject({ code: "page-closed" });
    await expect(page.evaluate("document.title")).rejects.toMatchObject({
      code: "page-closed",
    });
    await session.close();
  });

  it("normalizes operation failures instead of hiding them", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext();
    const page = await context.newPage();

    browser.context.page.goto.mockRejectedValueOnce(
      new Error("navigation failed"),
    );
    await expect(page.goto("http://example.test")).rejects.toMatchObject({
      code: "operation-failed",
    });
    browser.context.page.innerText.mockRejectedValueOnce(
      new Error("read failed"),
    );
    await expect(page.text()).rejects.toMatchObject({
      code: "operation-failed",
    });
    browser.context.page.waitForLoadState.mockRejectedValueOnce(
      new Error("render failed"),
    );
    await expect(page.settle()).rejects.toMatchObject({
      code: "operation-failed",
    });
    await session.close();
  });

  it("returns an unsettled result for a bounded load-state timeout", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext();
    const page = await context.newPage();
    browser.context.page.waitForLoadState.mockRejectedValueOnce(
      new Error("Timeout 100ms exceeded"),
    );

    await expect(page.settle({ timeoutMs: 100 })).resolves.toMatchObject({
      settled: false,
    });
    await session.close();
  });

  it("distinguishes page crashes, closed contexts, and browser disconnects", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext();
    const page = await context.newPage();

    browser.context.page.emit("crash");
    await expect(page.text()).rejects.toMatchObject({ code: "page-crashed" });

    await context.close();
    await expect(context.newPage()).rejects.toMatchObject({
      code: "context-closed",
    });
    browser.emit("disconnected");
    await expect(session.newContext()).rejects.toMatchObject({
      code: "browser-disconnected",
    });
    await session.close();
  });

  it("exposes a typed error code", () => {
    const error = new BrowserDriverError("page-crashed", "crashed");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("page-crashed");
  });

  it("runs the pinned Playwright installer with optional system dependencies", () => {
    spawnSync.mockReturnValue({ status: 0, stdout: "ok", stderr: "" });
    expect(installChromium()).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(spawnSync).toHaveBeenLastCalledWith(
      process.execPath,
      expect.arrayContaining(["install", "chromium"]),
      { encoding: "utf8" },
    );

    spawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "deps failed" });
    expect(installChromium(true)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "deps failed",
    });
    expect(spawnSync).toHaveBeenLastCalledWith(
      process.execPath,
      expect.arrayContaining(["install", "--with-deps", "chromium"]),
      { encoding: "utf8" },
    );

    spawnSync.mockReturnValue({
      error: new Error("spawn failed"),
      stdout: "",
      stderr: "",
    });
    expect(installChromium()).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "spawn failed",
    });
  });
});
