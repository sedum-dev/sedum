import type { BrowserContext, Page, Request, Response } from "playwright-core";

/** A deterministic browser signal, kept in arrival order until drained. */
export interface BrowserSignal {
  readonly kind:
    | "console_error"
    | "uncaught_exception"
    | "unhandled_rejection"
    | "http_error";
  readonly message: string;
  /** Script, resource, or response URL; empty when the browser gave none. */
  readonly url: string;
  /** HTTP status, or 0 when the request failed without a response. */
  readonly status?: number;
  /** Playwright resource type, such as document, fetch, xhr, or image. */
  readonly resourceType?: string;
}

export interface SignalSettleOptions {
  /** Longest wait for in-flight requests to finish. */
  readonly maxMs: number;
  /** How long the network must stay idle. */
  readonly idleMs?: number;
}

/** The page's signals since the last drain. */
export interface BrowserSignalSource {
  /** Wait briefly for in-flight requests so their outcome lands on this step. */
  settle(options: SignalSettleOptions): Promise<void>;
  drain(): readonly BrowserSignal[];
}

interface ExceptionDetails {
  readonly exceptionId: number;
  readonly text: string;
  readonly url?: string;
  readonly exception?: {
    readonly description?: string;
    readonly value?: unknown;
  };
}

const MESSAGE_LIMIT = 400;
/** Leaves room after the URL for the method, status, or error in an HTTP message. */
const URL_LIMIT = 300;
const BUFFER_LIMIT = 200;
/** Chrome logs every failed resource load as a console error; the response is reported once, as http_error. */
const RESOURCE_ECHO = /^Failed to load resource: /u;

function clip(text: string): string {
  const single = text.replace(/\s+/gu, " ").trim();
  return single.length > MESSAGE_LIMIT
    ? `${single.slice(0, MESSAGE_LIMIT - 1)}…`
    : single;
}

function clipUrl(url: string): string {
  return url.length > URL_LIMIT ? `${url.slice(0, URL_LIMIT - 1)}…` : url;
}

function exceptionMessage(details: ExceptionDetails): string {
  const description = details.exception?.description?.split("\n")[0];
  if (description) return description;
  const value = details.exception?.value;
  return value === undefined || value === null ? details.text : String(value);
}

/**
 * Buffers console errors, uncaught exceptions, unhandled rejections, and HTTP
 * errors for one page, including fetch and XHR. Exceptions come from the
 * Chrome DevTools protocol: it separates "Uncaught" from "Uncaught (in
 * promise)" and revokes a rejection that gains a handler later.
 */
export class PageSignalCollector implements BrowserSignalSource {
  private buffer: { signal: BrowserSignal; exceptionId?: number }[] = [];
  private readonly inFlight = new Set<Request>();
  private lastNetworkEvent = performance.now();

  private constructor(private readonly page: Page) {}

  static async attach(
    page: Page,
    context: BrowserContext,
  ): Promise<PageSignalCollector> {
    const collector = new PageSignalCollector(page);
    collector.listen();
    try {
      const session = await context.newCDPSession(page);
      session.on("Runtime.exceptionThrown", (event) =>
        collector.exception(event.exceptionDetails as ExceptionDetails),
      );
      session.on("Runtime.exceptionRevoked", (event) =>
        collector.revoke(event.exceptionId),
      );
      await session.send("Runtime.enable");
    } catch {
      // Without CDP exceptions the other signals still report.
      page.on("pageerror", (error) =>
        collector.push({
          kind: "uncaught_exception",
          message: clip(`${error.name}: ${error.message}`),
          url: "",
        }),
      );
    }
    return collector;
  }

  private listen(): void {
    this.page.on("console", (message) => {
      if (message.type() !== "error" || RESOURCE_ECHO.test(message.text()))
        return;
      this.push({
        kind: "console_error",
        message: clip(message.text()),
        url: message.location().url ?? "",
      });
    });
    this.page.on("request", (request) => this.started(request));
    this.page.on("requestfinished", (request) => this.finished(request));
    this.page.on("requestfailed", (request) => {
      this.finished(request);
      this.failed(request);
    });
    this.page.on("response", (response) => this.response(response));
  }

  private started(request: Request): void {
    this.inFlight.add(request);
    this.lastNetworkEvent = performance.now();
  }

  private finished(request: Request): void {
    this.inFlight.delete(request);
    this.lastNetworkEvent = performance.now();
  }

  private response(response: Response): void {
    const request = response.request();
    // The status is all the detector needs; an unread body never "finishes".
    this.finished(request);
    const status = response.status();
    if (status < 400) return;
    this.push({
      kind: "http_error",
      message: clip(
        `${request.method()} ${clipUrl(response.url())} returned ${status} ${response.statusText()}`,
      ),
      url: response.url(),
      status,
      resourceType: request.resourceType(),
    });
  }

  private failed(request: Request): void {
    const errorText = request.failure()?.errorText ?? "request failed";
    // Navigation and page teardown abort requests; that is not a page fault.
    if (errorText === "net::ERR_ABORTED") return;
    this.push({
      kind: "http_error",
      message: clip(
        `${request.method()} ${clipUrl(request.url())} failed: ${errorText}`,
      ),
      url: request.url(),
      status: 0,
      resourceType: request.resourceType(),
    });
  }

  private exception(details: ExceptionDetails): void {
    const rejection = details.text.startsWith("Uncaught (in promise)");
    this.push(
      {
        kind: rejection ? "unhandled_rejection" : "uncaught_exception",
        message: clip(exceptionMessage(details)),
        url: details.url ?? "",
      },
      details.exceptionId,
    );
  }

  private revoke(exceptionId: number): void {
    this.buffer = this.buffer.filter(
      (entry) => entry.exceptionId !== exceptionId,
    );
  }

  private push(signal: BrowserSignal, exceptionId?: number): void {
    if (this.buffer.length >= BUFFER_LIMIT) return;
    this.buffer.push(
      exceptionId === undefined ? { signal } : { signal, exceptionId },
    );
  }

  /** Idle is measured from the later of the last request and this call, so late events still land. */
  async settle({ maxMs, idleMs = 150 }: SignalSettleOptions): Promise<void> {
    const started = performance.now();
    const deadline = started + maxMs;
    while (performance.now() < deadline && !this.page.isClosed()) {
      const idle =
        this.inFlight.size === 0 &&
        performance.now() - Math.max(this.lastNetworkEvent, started) >= idleMs;
      if (idle) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  drain(): readonly BrowserSignal[] {
    const drained = this.buffer.map((entry) => entry.signal);
    this.buffer = [];
    return drained;
  }
}
