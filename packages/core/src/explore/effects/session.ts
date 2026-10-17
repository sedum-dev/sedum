import type { BrowserContext } from "playwright-core";
import type { BrowserPage } from "../../browser-driver.js";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const CLEAR_STORAGE = `(() => {
  try { localStorage.clear(); sessionStorage.clear(); } catch {}
})()`;

/** Put back one origin's local storage as the run started with it. */
const RESTORE_STORAGE = String.raw`((items) => {
  try { for (const { name, value } of items) localStorage.setItem(name, value); } catch {}
})`;

/**
 * The browser state a run starts with (the cookies and storage it was given,
 * such as a signed-in session), so a fresh session can go back to it.
 */
export class SessionStart {
  readonly #state: Promise<StorageState | undefined>;

  /** Capture now: before the explorer opens the start page. */
  constructor(page: BrowserPage) {
    this.#state = Promise.resolve(
      page.playwright?.().context.storageState(),
    ).catch(() => undefined);
  }

  /**
   * Start a fresh session in the same page: the app forgets the cart, the
   * account it made, and whatever state it was stuck in, but keeps what the
   * run was started with.
   */
  async restore(page: BrowserPage): Promise<void> {
    const state = await this.#state;
    await restoreCookies(page.playwright?.().context, state);
    await page.evaluate(CLEAR_STORAGE).catch(() => undefined);
    await restoreStorage(page, state);
  }
}

async function restoreCookies(
  context: BrowserContext | undefined,
  state: StorageState | undefined,
): Promise<void> {
  if (!context) return;
  await context.clearCookies().catch(() => undefined);
  if (state?.cookies.length)
    await context.addCookies(state.cookies).catch(() => undefined);
}

async function restoreStorage(
  page: BrowserPage,
  state: StorageState | undefined,
): Promise<void> {
  const origin = new URL(page.url).origin;
  const items = state?.origins.find((o) => o.origin === origin)?.localStorage;
  if (!items?.length) return;
  await page
    .evaluate(`${RESTORE_STORAGE}(${JSON.stringify(items)})`)
    .catch(() => undefined);
}
