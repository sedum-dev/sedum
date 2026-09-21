import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type { Aim, AimResult } from "./page-protocol.js";

export type BrowserKind = "chrome" | "chromium";

export interface BrowserLaunchOptions {
  readonly browser?: BrowserKind;
  readonly headless?: boolean;
  readonly slowMoMs?: number;
}

export interface BrowserContextOptions {
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly locale?: string;
}

export interface NavigationOptions {
  readonly timeoutMs?: number;
  readonly waitUntil?: "commit" | "domcontentloaded" | "load";
}

export interface SettleOptions {
  readonly timeoutMs?: number;
  readonly state?: "domcontentloaded" | "load";
}

export interface NavigationResult {
  readonly url: string;
}

export interface SettleResult {
  readonly settled: boolean;
  readonly elapsedMs: number;
}

export type BrowserDriverErrorCode =
  | "browser-missing"
  | "browser-launch-failed"
  | "browser-disconnected"
  | "context-closed"
  | "page-closed"
  | "page-crashed"
  | "operation-failed"
  | "script-missing";

export class BrowserDriverError extends Error {
  readonly code: BrowserDriverErrorCode;

  constructor(code: BrowserDriverErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserDriverError";
    this.code = code;
  }
}

export interface BrowserPage {
  readonly url: string;
  readonly closed: boolean;
  goto(url: string, options?: NavigationOptions): Promise<NavigationResult>;
  settle(options?: SettleOptions): Promise<SettleResult>;
  text(): Promise<string>;
  evaluate<T>(expression: string, argument?: unknown): Promise<T>;
  clickRef(aim: Aim): Promise<AimResult>;
  close(): Promise<void>;
}

export interface BrowserContextSession {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserSession {
  newContext(options?: BrowserContextOptions): Promise<BrowserContextSession>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  launch(options?: BrowserLaunchOptions): Promise<BrowserSession>;
}

export interface BrowserInstallResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_TIMEOUT_MS = 4_000;
const require = createRequire(import.meta.url);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingExecutable(error: unknown): boolean {
  return /executable does not exist|executable.*doesn't exist|executable.*not found|channel .* is not installed|ENOENT/i.test(
    errorText(error),
  );
}

function missingBrowserError(): BrowserDriverError {
  return new BrowserDriverError(
    "browser-missing",
    "No supported browser binary was found. Run `sedum browsers install chromium` and retry.",
  );
}

function operationError(
  error: unknown,
  state: {
    readonly disconnected: boolean;
    readonly closed: boolean;
    readonly crashed: boolean;
  },
  subject: "context" | "page",
): BrowserDriverError {
  if (state.crashed) {
    return new BrowserDriverError(
      "page-crashed",
      "The browser page crashed during the operation.",
      error,
    );
  }
  if (state.disconnected) {
    return new BrowserDriverError(
      "browser-disconnected",
      "The browser disconnected or crashed during the operation.",
      error,
    );
  }
  if (state.closed) {
    return new BrowserDriverError(
      subject === "page" ? "page-closed" : "context-closed",
      `The browser ${subject} was closed before the operation completed.`,
      error,
    );
  }
  return new BrowserDriverError("operation-failed", errorText(error), error);
}

class PlaywrightPage implements BrowserPage {
  private crashed = false;
  private closedByDriver = false;

  constructor(
    private readonly page: Page,
    private readonly contextState: () => BrowserDriverState,
  ) {
    page.on("crash", () => {
      this.crashed = true;
    });
    page.on("close", () => {
      this.closedByDriver = true;
    });
  }

  get url(): string {
    return this.page.url();
  }

  get closed(): boolean {
    return this.closedByDriver || this.page.isClosed();
  }

  private state(): BrowserDriverState {
    return {
      ...this.contextState(),
      closed: this.closed,
      crashed: this.crashed,
    };
  }

  async goto(
    url: string,
    options: NavigationOptions = {},
  ): Promise<NavigationResult> {
    const currentState = this.state();
    if (
      currentState.closed ||
      currentState.crashed ||
      currentState.disconnected
    ) {
      throw operationError(
        new Error("page is not available"),
        currentState,
        "page",
      );
    }
    try {
      await this.page.goto(url, {
        timeout: options.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
        waitUntil: options.waitUntil ?? "domcontentloaded",
      });
      return { url: this.page.url() };
    } catch (error) {
      throw operationError(error, this.state(), "page");
    }
  }

  async settle(options: SettleOptions = {}): Promise<SettleResult> {
    const currentState = this.state();
    if (
      currentState.closed ||
      currentState.crashed ||
      currentState.disconnected
    ) {
      throw operationError(
        new Error("page is not available"),
        currentState,
        "page",
      );
    }
    const started = performance.now();
    try {
      await this.page.waitForLoadState(options.state ?? "load", {
        timeout: options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      });
      return { settled: true, elapsedMs: performance.now() - started };
    } catch (error) {
      const state = this.state();
      if (state.closed || state.crashed || state.disconnected) {
        throw operationError(error, state, "page");
      }
      if (/timeout/i.test(errorText(error))) {
        return { settled: false, elapsedMs: performance.now() - started };
      }
      throw operationError(error, state, "page");
    }
  }

  async text(): Promise<string> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected) {
      throw operationError(new Error("page is not available"), state, "page");
    }
    try {
      return await this.page.locator("body").innerText();
    } catch (error) {
      throw operationError(error, this.state(), "page");
    }
  }

  async evaluate<T>(expression: string, argument?: unknown): Promise<T> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected) {
      throw operationError(new Error("page is not available"), state, "page");
    }
    try {
      return argument === undefined
        ? await this.page.evaluate(expression)
        : await this.page.evaluate(expression, argument);
    } catch (error) {
      throw operationError(error, this.state(), "page");
    }
  }

  async clickRef(aim: Aim): Promise<AimResult> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected)
      throw operationError(new Error("page is not available"), state, "page");
    const checked = await this.page.evaluate(
      (expected) =>
        window.__sedum?.checkAim(expected) ?? {
          actionable: false,
          reason: "stale",
        },
      aim,
    );
    if (!checked.actionable) return checked as AimResult;
    const handle = await this.page.evaluateHandle((ref) => {
      const matches = Array.from(
        document.querySelectorAll("[data-sedum-ref]"),
      ).filter((element) => element.getAttribute("data-sedum-ref") === ref);
      return matches.length === 1 ? matches[0] : null;
    }, aim.ref);
    try {
      const element = handle.asElement();
      if (!element) return { actionable: false, reason: "target_missing" };
      const still = await this.page.evaluate(
        ({ expected, element }) => {
          if (
            !element.isConnected ||
            element.getAttribute("data-sedum-ref") !== expected.ref
          )
            return { actionable: false, reason: "target_missing" };
          return (
            window.__sedum?.checkAim(expected) ?? {
              actionable: false,
              reason: "stale",
            }
          );
        },
        { expected: aim, element },
      );
      if (!still.actionable) return still as AimResult;
      const guard = await this.page.evaluateHandle(
        ({ expected, element }) => {
          let blocked = false;
          const types = [
            "pointerdown",
            "mousedown",
            "mouseup",
            "click",
          ] as const;
          const check = (event: Event) => {
            const target = event.target;
            const validReceiver =
              target instanceof Node &&
              (target === element || element.contains(target));
            if (validReceiver && window.__sedum?.checkAim(expected).actionable)
              return;
            blocked = true;
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          for (const type of types)
            document.addEventListener(type, check, true);
          return {
            blocked: () => blocked,
            stop: () => {
              for (const type of types)
                document.removeEventListener(type, check, true);
            },
          };
        },
        { expected: aim, element },
      );
      const routeBeforeClick = this.page.url();
      let armed: boolean;
      try {
        armed = await this.page.evaluate(
          (expected) => window.__sedum?.armClick(expected) ?? false,
          aim,
        );
      } catch (error) {
        await guard.evaluate((value) => value.stop()).catch(() => undefined);
        await guard.dispose().catch(() => undefined);
        throw operationError(error, this.state(), "page");
      }
      if (!armed) {
        await guard.evaluate((value) => value.stop()).catch(() => undefined);
        await guard.dispose().catch(() => undefined);
        return { actionable: false, reason: "stale" };
      }
      let finished = false;
      try {
        // Playwright may dispatch hover/capture events before pointerdown. Once it
        // starts, a failure cannot prove that the page saw no side effect.
        await element.click({ position: aim.point, timeout: 1000 });
        try {
          const early = await this.page.evaluate(
            () =>
              window.__sedum?.finishClick() ?? {
                blocked: true,
                heldHref: null,
                pageCanceled: false,
                cancellationUnknown: true,
              },
          );
          finished = true;
          if (
            early.blocked ||
            (await guard.evaluate((value) => value.blocked()))
          )
            return {
              actionable: false,
              reason: "action_started",
              retryable: false,
            };
          if (early.heldHref) {
            if (early.cancellationUnknown)
              return {
                actionable: false,
                reason: "action_started",
                retryable: false,
              };
            const currentRoute = this.page.url();
            if (
              currentRoute !== routeBeforeClick &&
              currentRoute !== early.heldHref
            )
              return {
                actionable: false,
                reason: "action_started",
                retryable: false,
              };
            if (early.pageCanceled) return { actionable: true, aim };
            if (currentRoute === routeBeforeClick) {
              await this.page.evaluate(
                (href) => window.location.assign(href),
                early.heldHref,
              );
              await this.page.waitForURL(early.heldHref, { timeout: 1000 });
            }
          }
        } catch {
          return {
            actionable: false,
            reason: "action_started",
            retryable: false,
          };
        }
        return { actionable: true, aim };
      } catch {
        return {
          actionable: false,
          reason: "action_started",
          retryable: false,
        };
      } finally {
        if (!finished)
          await this.page
            .evaluate(() => window.__sedum?.finishClick())
            .catch(() => undefined);
        await guard.evaluate((value) => value.stop()).catch(() => undefined);
        await guard.dispose().catch(() => undefined);
      }
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.page.close();
  }
}

interface BrowserDriverState {
  readonly disconnected: boolean;
  readonly closed: boolean;
  readonly crashed: boolean;
}

class PlaywrightContext implements BrowserContextSession {
  private closed = false;

  constructor(
    private readonly context: BrowserContext,
    private readonly browserState: () => BrowserDriverState,
  ) {
    context.on("close", () => {
      this.closed = true;
    });
  }

  async newPage(): Promise<BrowserPage> {
    if (this.closed) {
      throw new BrowserDriverError(
        "context-closed",
        "The browser context is already closed.",
      );
    }
    try {
      return new PlaywrightPage(await this.context.newPage(), () => ({
        ...this.browserState(),
        closed: this.closed,
        crashed: false,
      }));
    } catch (error) {
      throw operationError(
        error,
        { ...this.browserState(), closed: this.closed, crashed: false },
        "context",
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.context.close();
    this.closed = true;
  }
}

class PlaywrightSession implements BrowserSession {
  private disconnected = false;
  private closed = false;

  constructor(private readonly browser: Browser) {
    browser.on("disconnected", () => {
      this.disconnected = true;
    });
  }

  private state(): BrowserDriverState {
    return {
      disconnected: this.disconnected,
      closed: this.closed,
      crashed: false,
    };
  }

  async newContext(
    options: BrowserContextOptions = {},
  ): Promise<BrowserContextSession> {
    if (this.closed || this.disconnected) {
      throw operationError(
        new Error("browser is not connected"),
        this.state(),
        "context",
      );
    }
    try {
      const context = await this.browser.newContext({
        ...(options.viewport === undefined
          ? {}
          : { viewport: options.viewport }),
        ...(options.locale === undefined ? {} : { locale: options.locale }),
      });
      const installed = fileURLToPath(
        new URL("./page-script/index.global.js", import.meta.url),
      );
      const sourceTestAsset = fileURLToPath(
        new URL("../dist/page-script/index.global.js", import.meta.url),
      );
      const asset = existsSync(installed) ? installed : sourceTestAsset;
      if (!existsSync(asset)) {
        await context.close();
        throw new BrowserDriverError(
          "script-missing",
          "The built Sedum page script is missing. Build @sedum-dev/core before launching a context.",
        );
      }
      await context.addInitScript({ path: asset });
      return new PlaywrightContext(context, () => this.state());
    } catch (error) {
      if (
        error instanceof BrowserDriverError &&
        error.code === "script-missing"
      )
        throw error;
      throw operationError(error, this.state(), "context");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.browser.close();
  }
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  async launch(options: BrowserLaunchOptions = {}): Promise<BrowserSession> {
    const headless = options.headless ?? true;
    const slowMo = options.slowMoMs ?? 0;
    const browserKind = options.browser ?? "chrome";

    if (browserKind === "chrome") {
      try {
        return new PlaywrightSession(
          await chromium.launch({ channel: "chrome", headless, slowMo }),
        );
      } catch (error) {
        if (!isMissingExecutable(error)) {
          throw new BrowserDriverError(
            "browser-launch-failed",
            errorText(error),
            error,
          );
        }
      }
    }

    if (!existsSync(chromium.executablePath())) {
      throw missingBrowserError();
    }

    try {
      return new PlaywrightSession(await chromium.launch({ headless, slowMo }));
    } catch (error) {
      if (isMissingExecutable(error)) throw missingBrowserError();
      throw new BrowserDriverError(
        "browser-launch-failed",
        errorText(error),
        error,
      );
    }
  }
}

export function installChromium(withDeps = false): BrowserInstallResult {
  const playwrightEntry = require.resolve("playwright-core");
  const cliPath = join(dirname(playwrightEntry), "cli.js");
  const args = [cliPath, "install"];
  if (withDeps) args.push("--with-deps");
  args.push("chromium");
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.error !== undefined) {
    return { exitCode: 1, stdout: result.stdout, stderr: result.error.message };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
