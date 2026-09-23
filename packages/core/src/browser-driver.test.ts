import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launch, executablePath } = vi.hoisted(() => ({
  launch: vi.fn(),
  executablePath: vi.fn(),
}));
const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
const pageScriptPath = /(?:^|[\\/])page-script[\\/]index\.global\.js$/;

vi.mock("playwright-core", () => ({
  chromium: { launch, executablePath },
}));
vi.mock("node:child_process", () => ({ spawnSync }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: string) =>
      pageScriptPath.test(path) || actual.existsSync(path),
  };
});

import {
  BrowserDriverError,
  PlaywrightBrowserDriver,
  findBrowserExecutable,
  installChromium,
} from "./browser-driver.js";

describe("browser executable discovery", () => {
  it("rejects directories and files without execute permission", () => {
    launch.mockClear();
    const root = mkdtempSync(path.join(tmpdir(), "sedum-browser-probe-"));
    try {
      executablePath.mockReturnValue(root);
      expect(findBrowserExecutable("chromium")).toBeNull();
      const binary = path.join(root, "chromium");
      writeFileSync(binary, "binary", { mode: 0o600 });
      executablePath.mockReturnValue(binary);
      if (process.platform !== "win32")
        expect(findBrowserExecutable("chromium")).toBeNull();
      chmodSync(binary, 0o700);
      expect(findBrowserExecutable("chromium")).toBe(binary);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      executablePath.mockReset();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

class FakePage extends EventEmitter {
  private currentUrl = "about:blank";
  private isClosedValue = false;
  readonly goto = vi.fn(async (url: string) => {
    this.currentUrl = url;
    return null;
  });
  readonly waitForLoadState = vi.fn(async () => undefined);
  readonly innerText = vi.fn(async () => "fixture page");
  readonly keyboard = { press: vi.fn(async () => undefined) };
  readonly mouse = { wheel: vi.fn(async () => undefined) };
  readonly cdp = {
    send: vi.fn(async (...args: unknown[]) => {
      void args;
    }),
    detach: vi.fn(async () => undefined),
  };
  readonly cdpContext = { newCDPSession: vi.fn(async () => this.cdp) };
  readonly target = {
    waitForElementState: vi.fn(async () => undefined),
    boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 30 })),
    click: vi.fn(async () => undefined),
  };
  readonly evaluateHandle = vi.fn(async () => ({
    asElement: () => this.target,
    dispose: vi.fn(async () => undefined),
  }));

  context() {
    return this.cdpContext;
  }

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
  readonly addInitScript = vi.fn(async () => undefined);

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

  it("marks a headed action with a browser overlay and removes it after dispatch", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
      headless: false,
      overlay: true,
    });
    const context = await session.newContext();
    const page = await context.newPage();
    vi.spyOn(browser.context.page, "evaluate").mockResolvedValue({
      actionable: true,
    } as never);
    const aim = {
      ref: "target",
      document: "doc",
      route: "https://example.test",
      revision: 1,
      tag: "button",
      name: "Submit",
      point: { x: 5, y: 5 },
    };
    await expect(page.clickRef(aim)).resolves.toMatchObject({
      actionable: true,
    });
    expect(
      browser.context.page.cdp.send.mock.calls.map(([method]) => method),
    ).toEqual([
      "Overlay.enable",
      "Overlay.highlightRect",
      "Overlay.hideHighlight",
    ]);
    expect(browser.context.page.target.click).toHaveBeenCalledOnce();
    expect(browser.context.page.cdp.detach).toHaveBeenCalledOnce();
    await session.close();
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
    expect(browser.context.addInitScript).toHaveBeenCalledWith({
      path: expect.stringMatching(pageScriptPath),
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

  it("keeps sensitive action arguments and raw causes out of safe driver errors", async () => {
    const browser = new FakeBrowser();
    launch.mockResolvedValue(browser);
    const session = await new PlaywrightBrowserDriver().launch({
      browser: "chromium",
    });
    const context = await session.newContext();
    const page = await context.newPage();
    const secret = "TOP_SECRET";
    browser.context.page.goto.mockRejectedValueOnce(
      new Error(
        `goto ${secret}\nCall log:\n  - waiting for scheduled navigations to finish\n  - goto ${secret}`,
      ),
    );
    let failure: unknown;
    try {
      await page.goto(`http://example.test/${secret}`, {
        safeDiagnostics: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "operation-failed",
    });
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(secret);
    expect((failure as Error).stack).not.toContain(secret);
    expect(String(failure)).toContain(
      "waiting for scheduled navigations to finish",
    );
    expect(String(failure)).toContain("[action argument redacted]");

    browser.context.page.keyboard.press.mockRejectedValueOnce(
      new Error(`press ${secret}`),
    );
    await expect(page.press(secret)).rejects.toMatchObject({
      code: "operation-failed",
      message: "Key press failed.",
    });
    browser.context.page.mouse.wheel.mockRejectedValueOnce(
      new Error(`wheel ${secret}`),
    );
    await expect(page.scroll(100)).rejects.toMatchObject({
      code: "operation-failed",
      message: "Scroll failed.",
    });
    await expect(page.press("A", { timeoutMs: 0 })).rejects.toMatchObject({
      code: "operation-failed",
    });
    expect(browser.context.page.keyboard.press).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it.each(["press", "scroll"] as const)(
    "closes and drains a timed-out %s before handing back control",
    async (action) => {
      const browser = new FakeBrowser();
      launch.mockResolvedValue(browser);
      const session = await new PlaywrightBrowserDriver().launch({
        browser: "chromium",
      });
      const context = await session.newContext();
      const page = await context.newPage();
      const underlyingPage = browser.context.page;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lateEffects = 0;
      const input = vi.fn(async () => {
        await pending;
        if (!underlyingPage.isClosed()) lateEffects++;
      });
      if (action === "press") underlyingPage.keyboard.press = input;
      else underlyingPage.mouse.wheel = input;

      const result =
        action === "press"
          ? page.press("A", { timeoutMs: 5 })
          : page.scroll(100, { timeoutMs: 5 });
      let returned = false;
      void result.then(
        () => {
          returned = true;
        },
        () => {
          returned = true;
        },
      );
      await vi.waitFor(() => expect(page.closed).toBe(true));
      expect(returned).toBe(false);
      release();
      await expect(result).rejects.toMatchObject({ code: "page-closed" });
      expect(returned).toBe(true);
      expect(lateEffects).toBe(0);
      await expect(page.press("B")).rejects.toMatchObject({
        code: "page-closed",
      });
      expect(input).toHaveBeenCalledTimes(1);
      await session.close();
    },
  );

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
