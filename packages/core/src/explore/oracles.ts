import type { BrowserContext, Page } from "playwright-core";
import type { BrowserPage } from "../browser-driver.js";
import {
  allowed,
  DEFAULT_ALLOW,
  parseAllowRule,
  signalDetection,
  type AllowRule,
  type Detection,
} from "../detector/checks.js";
import {
  PageSignalCollector,
  type BrowserSignal,
  type BrowserSignalSource,
} from "../detector/signals.js";
import type { OracleEvent, OracleOptions, WriteRecord } from "./types.js";

interface Response {
  status(): number;
  url(): string;
  text(): Promise<string>;
  request(): {
    method(): string;
    resourceType(): string;
    postData(): string | null;
    isNavigationRequest(): boolean;
    frame(): unknown;
  };
}

const NOT_REJECTIONS = new Set([401, 403, 404]);
/** Methods that change nothing; QUERY is HTTP's read with a body. */
const READS = new Set(["GET", "HEAD", "OPTIONS", "QUERY"]);

/**
 * A successful request that may change data: not a read, not a failure,
 * and not a beacon (sendBeacon: analytics, RUM), which only reports.
 */
function changesData(response: Response): boolean {
  const request = response.request();
  if (READS.has(request.method()) || response.status() >= 400) return false;
  return request.resourceType() !== "ping";
}

/** API paths name records by slug or id; keep one signature per endpoint. */
export function endpoint(pathname: string): string {
  return pathname
    .split("/")
    .map((part) => (/\d|-/u.test(part) && part.length > 8 ? ":id" : part))
    .join("/");
}

/**
 * For a GraphQL endpoint: null when every operation is a query (a read),
 * else the mutation names. "" for any other request, which counts as a write.
 */
export function graphqlMutation(url: URL, body: string | null): string | null {
  if (!url.pathname.endsWith("graphql") || !body) return "";
  const operations = parseJson(body);
  const list = (Array.isArray(operations) ? operations : [operations]) as {
    query?: unknown;
    operationName?: unknown;
  }[];
  const mutations = list.filter(
    (op) => typeof op?.query === "string" && /^\s*mutation\b/u.test(op.query),
  );
  if (operations !== undefined && !mutations.length) return null;
  return mutations
    .map((op) => String(op.operationName ?? "mutation"))
    .join(",");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Allow rules: the detector's defaults, the run's own, and ignored console text. */
function allowRules(options: OracleOptions): AllowRule[] {
  return [
    ...DEFAULT_ALLOW,
    ...(options.allow ?? []),
    ...(options.ignoreConsole ?? []).map(
      (source) => `console_error:re:${source}`,
    ),
  ].map(parseAllowRule);
}

/**
 * Bombadil's default properties as event collectors. Console errors,
 * uncaught exceptions, unhandled rejections and failed requests come from
 * the bug detector's signal collector (`--detect browser`); HTTP 5xx,
 * broken links, rejected submits and the write log are exploration's own.
 * Consumers drain events after each settled step.
 */
export class Oracles {
  #events: OracleEvent[] = [];
  #pending: Promise<void>[] = [];
  /** A page answered 4xx this step, unless a working page replaced it. */
  #deadEnd: string | null = null;
  #writes: WriteRecord[] = [];
  readonly #allow: readonly AllowRule[];
  readonly #mainFrame: unknown;
  readonly #detach: () => void;

  /** Attach to a page; the detector's collector needs the browser context. */
  static async attach(
    page: BrowserPage,
    origin: string,
    options: OracleOptions = {},
  ): Promise<Oracles> {
    const native = page.playwright?.();
    if (!native) throw new Error("Exploration needs a Playwright page.");
    const signals = await PageSignalCollector.attach(
      native.page,
      native.context,
    );
    return new Oracles(native, origin, options, signals);
  }

  private constructor(
    native: { readonly page: Page; readonly context: BrowserContext },
    private readonly origin: string,
    private readonly options: OracleOptions,
    private readonly signals: BrowserSignalSource,
  ) {
    const browserPage = native.page;
    this.#mainFrame = browserPage.mainFrame();
    this.#allow = allowRules(options);
    const onResponse = (response: Response) => this.#response(response);
    // Explorations never follow new windows; close them.
    const onPopup = (popup: { close(): Promise<void> }) => {
      void popup.close().catch(() => undefined);
    };
    browserPage.on("response", onResponse);
    browserPage.on("popup", onPopup);
    this.#detach = () => {
      browserPage.off("response", onResponse);
      browserPage.off("popup", onPopup);
    };
  }

  #watched(url: URL): boolean {
    return (
      url.origin === this.origin ||
      (this.options.watchOrigins ?? []).includes(url.origin)
    );
  }

  /**
   * A detector signal as an exploration event. HTTP answers are left to the
   * response oracle, which tells 5xx, broken links and rejections apart;
   * only requests that failed without an answer come from here.
   */
  #signal(signal: BrowserSignal): void {
    if (allowed(signalDetection(signal), this.#allow)) return;
    const kind = SIGNAL_EVENTS[signal.kind];
    if (kind !== "http") return this.#push(kind, signal.message);
    if (signal.status !== 0 || !URL.canParse(signal.url)) return;
    if (this.#watched(new URL(signal.url))) this.#push("http", signal.message);
  }

  #response(response: Response): void {
    const url = new URL(response.url());
    if (!this.#watched(url)) return;
    const status = response.status();
    const method = response.request().method();
    const where = this.#where(url);
    this.#write(response, url);
    // A 404 page that sends the browser straight on to a working page (a
    // single-page app on static hosting) is not a dead end for the user.
    if (this.#mainNavigation(response) && status < 400) this.#deadEnd = null;
    if (status >= 500) this.#push("http", `HTTP ${status} ${method} ${where}`);
    else if (this.#brokenLink(response))
      this.#deadEnd = `HTTP ${status} page ${endpoint(where)}`;
    else if (this.#rejection(response))
      this.#pending.push(
        response
          .text()
          .catch(() => "")
          .then((body) =>
            this.#push(
              "rejected",
              `HTTP ${status} ${method} ${endpoint(where)}: ${body.slice(0, 160)}`,
            ),
          ),
      );
  }

  #mainNavigation(response: Response): boolean {
    const request = response.request();
    return request.isNavigationRequest() && request.frame() === this.#mainFrame;
  }

  /** A page the user navigated to that does not exist or failed. */
  #brokenLink(response: Response): boolean {
    return (
      this.options.brokenLinks !== false &&
      response.status() >= 400 &&
      this.#mainNavigation(response)
    );
  }

  #where(url: URL): string {
    return `${url.origin === this.origin ? "" : url.host}${url.pathname}`;
  }

  #write(response: Response, url: URL): void {
    const method = response.request().method();
    const status = response.status();
    if (!changesData(response)) return;
    const mutation = graphqlMutation(url, response.request().postData());
    if (mutation === null) return;
    const where = endpoint(this.#where(url));
    this.#writes.push({
      method,
      endpoint: mutation ? `${where} ${mutation}` : where,
      status,
    });
  }

  #rejection(response: Response): boolean {
    const status = response.status();
    const method = response.request().method();
    return (
      this.options.rejectedSubmits === true &&
      status >= 400 &&
      status < 500 &&
      !NOT_REJECTIONS.has(status) &&
      method !== "GET" &&
      method !== "HEAD"
    );
  }

  #push(kind: OracleEvent["kind"], message: string, identity?: string): void {
    const bounded = message.slice(0, 500);
    this.#events.push({
      kind,
      message: bounded,
      signature: `${kind}: ${identity ?? signature(bounded, this.origin)}`,
    });
  }

  /**
   * The detector's page checks for a new state, under its allow rules. One
   * finding per check and kind of page (`/clients/:id`), not per message.
   */
  report(detections: readonly Detection[], route: string): void {
    for (const detection of detections) {
      if (allowed(detection, this.#allow)) continue;
      this.#push(
        "semantic",
        `${detection.check} on ${route}: ${detection.message}`,
        `${detection.check} on ${route}`,
      );
    }
  }

  /** Events so far, after any response bodies still being read. */
  async drain(): Promise<OracleEvent[]> {
    for (const signal of this.signals.drain()) this.#signal(signal);
    if (this.#deadEnd) this.#push("broken-link", this.#deadEnd);
    this.#deadEnd = null;
    await Promise.all(this.#pending.splice(0));
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /** Successful non-GET requests since the last call. */
  drainWrites(): WriteRecord[] {
    return this.#writes.splice(0);
  }

  detach(): void {
    this.#detach();
  }
}

const SIGNAL_EVENTS: Readonly<
  Record<BrowserSignal["kind"], OracleEvent["kind"]>
> = {
  console_error: "console",
  uncaught_exception: "pageerror",
  unhandled_rejection: "rejection",
  http_error: "http",
};

/** Strip what varies between occurrences of the same failure. */
export function signature(message: string, origin: string): string {
  return message
    .split(origin)
    .join("")
    .replace(/\s+at .*$/gsu, "")
    .replace(/\d+/gu, "#")
    .slice(0, 200);
}
