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
import type { Aim, AimResult, FillTarget } from "./page-protocol.js";
import { safeCallLog } from "./safe-diagnostics.js";

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
  /** Exclude the requested URL and raw Playwright cause from public errors. */
  readonly safeDiagnostics?: boolean;
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
export type FillResult =
  | { readonly acted: true }
  | {
      readonly acted: false;
      readonly reason: "stale" | "not_actionable" | "action_started";
      readonly retryable: boolean;
      readonly callLog?: readonly string[];
    };

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
  clickRef(
    aim: Aim,
    options?: { readonly timeoutMs?: number },
  ): Promise<AimResult>;
  fillRef(
    target: FillTarget,
    value: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<FillResult>;
  press(key: string, options?: { readonly timeoutMs?: number }): Promise<void>;
  scroll(
    deltaY: number,
    options?: { readonly timeoutMs?: number },
  ): Promise<void>;
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
const DEFAULT_ACTION_TIMEOUT_MS = 8_000;
function actionTimeout(value?: number): number {
  if (value === undefined) return DEFAULT_ACTION_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    throw new RangeError("Invalid action timeout");
  return value;
}
async function boundedInput(
  operation: Promise<void>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Error("Action timed out");
  try {
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeout), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error === timeout) {
      // Keyboard.press and mouse.wheel have no Playwright timeout option.
      // Never hand this page back while a timed-out input may still arrive.
      await onTimeout();
      await operation.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
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

function safeOperationError(
  error: unknown,
  state: BrowserDriverState,
  operation: string,
): BrowserDriverError {
  const code: BrowserDriverErrorCode = state.crashed
    ? "page-crashed"
    : state.disconnected
      ? "browser-disconnected"
      : state.closed
        ? "page-closed"
        : "operation-failed";
  const lines = safeCallLog(error);
  return new BrowserDriverError(
    code,
    `${operation} failed.${lines.length ? `\nCall log:\n${lines.join("\n")}` : ""}`,
  );
}

class PlaywrightPage implements BrowserPage {
  private crashed = false;
  private closedByDriver = false;
  private terminalAfterInputTimeout = false;

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
    return (
      this.terminalAfterInputTimeout ||
      this.closedByDriver ||
      this.page.isClosed()
    );
  }

  private async terminateTimedOutInput(): Promise<void> {
    this.terminalAfterInputTimeout = true;
    if (!this.page.isClosed()) await this.page.close().catch(() => undefined);
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
      if (options.safeDiagnostics)
        throw safeOperationError(error, this.state(), "Navigation");
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

  async clickRef(
    aim: Aim,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<AimResult> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected)
      throw operationError(new Error("page is not available"), state, "page");
    const deadline = performance.now() + actionTimeout(options.timeoutMs);
    const remaining = () => Math.max(1, deadline - performance.now());
    const checked = await this.page
      .evaluate(
        (expected) =>
          window.__sedum?.checkAim(expected) ?? {
            actionable: false,
            reason: "stale",
          },
        aim,
      )
      .catch(() => ({ actionable: false as const, reason: "stale" as const }));
    if (!checked.actionable) return checked as AimResult;
    const handle = await this.page
      .evaluateHandle((ref) => {
        const matches = Array.from(
          document.querySelectorAll("[data-sedum-ref]"),
        ).filter((element) => element.getAttribute("data-sedum-ref") === ref);
        return matches.length === 1 ? matches[0] : null;
      }, aim.ref)
      .catch(() => null);
    if (!handle) return { actionable: false, reason: "stale" };
    try {
      const element = handle.asElement();
      if (!element) return { actionable: false, reason: "target_missing" };
      const validateElement = () =>
        this.page.evaluate(
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
      const still = await validateElement().catch(() => ({
        actionable: false as const,
        reason: "stale" as const,
      }));
      if (!still.actionable) return still as AimResult;
      try {
        // Wait for the exact element to settle without moving the pointer or
        // dispatching pointer/input events. The page can change during this wait,
        // so this is not the final snapshot validation.
        await element.waitForElementState("stable", { timeout: remaining() });
      } catch {
        return { actionable: false, reason: "not_actionable" };
      }
      const ready = await validateElement().catch(() => ({
        actionable: false as const,
        reason: "stale" as const,
      }));
      if (!ready.actionable) return ready as AimResult;
      try {
        // Playwright and the browser own final actionability, event dispatch,
        // cancellation, and navigation. Once this starts, a failure cannot
        // prove that page handlers saw no side effect, so it is non-retryable.
        await element.click({ position: aim.point, timeout: remaining() });
        return { actionable: true, aim };
      } catch (error) {
        return {
          actionable: false,
          reason: "action_started",
          retryable: false,
          callLog: safeCallLog(error),
        };
      }
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async fillRef(
    target: FillTarget,
    value: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<FillResult> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected)
      throw operationError(new Error("page is not available"), state, "page");
    const deadline = performance.now() + actionTimeout(options.timeoutMs);
    const remaining = () => Math.max(1, deadline - performance.now());
    const handle = await this.page
      .evaluateHandle(
        (expected) => window.__sedum?.fillElement(expected) ?? null,
        target,
      )
      .catch(() => null);
    if (!handle) return { acted: false, reason: "stale", retryable: true };
    try {
      const element = handle.asElement();
      if (!element) return { acted: false, reason: "stale", retryable: true };
      try {
        await element.waitForElementState("editable", { timeout: remaining() });
      } catch {
        return { acted: false, reason: "not_actionable", retryable: true };
      }
      const sameElement = await this.page
        .evaluate(
          ({ expected, element }) =>
            window.__sedum?.fillElement(expected) === element,
          { expected: target, element },
        )
        .catch(() => false);
      if (!sameElement)
        return { acted: false, reason: "stale", retryable: true };
      try {
        await element.fill(value, { timeout: remaining() });
        return { acted: true };
      } catch (error) {
        return {
          acted: false,
          reason: "action_started",
          retryable: false,
          callLog: safeCallLog(error),
        };
      }
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async press(
    key: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<void> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected)
      throw operationError(new Error("page is not available"), state, "page");
    try {
      const timeoutMs = actionTimeout(options.timeoutMs);
      await boundedInput(this.page.keyboard.press(key), timeoutMs, () =>
        this.terminateTimedOutInput(),
      );
    } catch (error) {
      throw safeOperationError(error, this.state(), "Key press");
    }
  }

  async scroll(
    deltaY: number,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<void> {
    const state = this.state();
    if (state.closed || state.crashed || state.disconnected)
      throw operationError(new Error("page is not available"), state, "page");
    try {
      const timeoutMs = actionTimeout(options.timeoutMs);
      await boundedInput(this.page.mouse.wheel(0, deltaY), timeoutMs, () =>
        this.terminateTimedOutInput(),
      );
    } catch (error) {
      throw safeOperationError(error, this.state(), "Scroll");
    }
  }

  async close(): Promise<void> {
    if (this.page.isClosed()) return;
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
