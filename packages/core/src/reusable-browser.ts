import type {
  BrowserDriver,
  BrowserLaunchOptions,
  BrowserSession,
} from "./browser-driver.js";

/**
 * One parallel lane's browser, following Playwright Test's worker model: the
 * lane launches a browser once and every attempt gets a fresh context. The
 * sessions handed out ignore `close()`, so an attempt closes only its own
 * context. `recycle()` closes the real browser; the next `launch()` starts a
 * new one, as Playwright replaces a worker after a crash.
 */
export class ReusableBrowserDriver implements BrowserDriver {
  private session: Promise<BrowserSession> | undefined;

  constructor(private readonly driver: BrowserDriver) {}

  async launch(options?: BrowserLaunchOptions): Promise<BrowserSession> {
    const pending = (this.session ??= this.driver.launch(options));
    let session: BrowserSession;
    try {
      session = await pending;
    } catch (error) {
      if (this.session === pending) this.session = undefined;
      throw error;
    }
    return {
      newContext: (contextOptions) => session.newContext(contextOptions),
      close: async () => undefined,
    };
  }

  /** Close the lane's browser; a later launch starts a fresh one. */
  async recycle(): Promise<void> {
    const pending = this.session;
    this.session = undefined;
    const session = await pending?.catch(() => undefined);
    await session?.close().catch(() => undefined);
  }
}
