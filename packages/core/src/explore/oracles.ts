import type { BrowserPage } from "../browser-driver.js";
import type { OracleEvent } from "./types.js";

interface ConsoleMessage {
  type(): string;
  text(): string;
}

interface Response {
  status(): number;
  url(): string;
  request(): { method(): string };
}

/**
 * Bombadil's default properties as event collectors: console errors,
 * uncaught exceptions and unhandled rejections, and HTTP 5xx responses.
 * Consumers drain events after each settled step.
 */
export class Oracles {
  #events: OracleEvent[] = [];
  readonly #detach: () => void;

  constructor(
    page: BrowserPage,
    private readonly origin: string,
  ) {
    const native = page.playwright?.();
    if (!native) throw new Error("Exploration needs a Playwright page.");
    const browserPage = native.page;
    const onConsole = (message: ConsoleMessage) => this.#console(message);
    const onPageError = (error: Error) =>
      this.#push("pageerror", `${error.name}: ${error.message}`);
    const onResponse = (response: Response) => this.#response(response);
    // Explorations never follow new windows; close them.
    const onPopup = (popup: { close(): Promise<void> }) => {
      void popup.close().catch(() => undefined);
    };
    browserPage.on("console", onConsole);
    browserPage.on("pageerror", onPageError);
    browserPage.on("response", onResponse);
    browserPage.on("popup", onPopup);
    this.#detach = () => {
      browserPage.off("console", onConsole);
      browserPage.off("pageerror", onPageError);
      browserPage.off("response", onResponse);
      browserPage.off("popup", onPopup);
    };
  }

  #console(message: ConsoleMessage): void {
    const text = message.text();
    // Resource failures are reported once, by the HTTP oracle.
    if (message.type() === "error" && !/^Failed to load resource/u.test(text))
      this.#push("console", text);
  }

  #response(response: Response): void {
    if (response.status() < 500) return;
    const url = new URL(response.url());
    if (url.origin === this.origin)
      this.#push(
        "http",
        `HTTP ${response.status()} ${response.request().method()} ${url.pathname}`,
      );
  }

  #push(kind: OracleEvent["kind"], message: string): void {
    const bounded = message.slice(0, 500);
    this.#events.push({
      kind,
      message: bounded,
      signature: `${kind}: ${signature(bounded, this.origin)}`,
    });
  }

  drain(): OracleEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  detach(): void {
    this.#detach();
  }
}

/** Strip what varies between occurrences of the same failure. */
export function signature(message: string, origin: string): string {
  return message
    .split(origin)
    .join("")
    .replace(/\s+at .*$/gsu, "")
    .replace(/\d+/gu, "#")
    .slice(0, 200);
}
