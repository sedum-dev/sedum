import type { BrowserPage } from "../browser-driver.js";
import type { OracleEvent, OracleOptions, WriteRecord } from "./types.js";

interface ConsoleMessage {
  type(): string;
  text(): string;
}

interface Response {
  status(): number;
  url(): string;
  text(): Promise<string>;
  request(): {
    method(): string;
    postData(): string | null;
    isNavigationRequest(): boolean;
    frame(): unknown;
  };
}

const NOT_REJECTIONS = new Set([401, 403, 404]);
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

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

/**
 * Bombadil's default properties as event collectors: console errors,
 * uncaught exceptions and unhandled rejections, and HTTP 5xx responses.
 * Consumers drain events after each settled step.
 */
export class Oracles {
  #events: OracleEvent[] = [];
  #pending: Promise<void>[] = [];
  #writes: WriteRecord[] = [];
  readonly #ignore: readonly RegExp[];
  readonly #mainFrame: unknown;
  readonly #detach: () => void;

  constructor(
    page: BrowserPage,
    private readonly origin: string,
    private readonly options: OracleOptions = {},
  ) {
    const native = page.playwright?.();
    if (!native) throw new Error("Exploration needs a Playwright page.");
    const browserPage = native.page;
    this.#mainFrame = browserPage.mainFrame();
    this.#ignore = (options.ignoreConsole ?? []).map(
      (source) => new RegExp(source, "u"),
    );
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
    if (message.type() !== "error" || /^Failed to load resource/u.test(text))
      return;
    if (!this.#ignore.some((pattern) => pattern.test(text)))
      this.#push("console", text);
  }

  #response(response: Response): void {
    const url = new URL(response.url());
    const watched =
      url.origin === this.origin ||
      (this.options.watchOrigins ?? []).includes(url.origin);
    if (!watched) return;
    const status = response.status();
    const method = response.request().method();
    const where = this.#where(url);
    this.#write(response, url);
    if (status >= 500) this.#push("http", `HTTP ${status} ${method} ${where}`);
    else if (this.#brokenLink(response))
      this.#push("broken-link", `HTTP ${status} page ${endpoint(where)}`);
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

  /** A page the user navigated to that does not exist or failed. */
  #brokenLink(response: Response): boolean {
    const request = response.request();
    return (
      this.options.brokenLinks !== false &&
      response.status() >= 400 &&
      request.isNavigationRequest() &&
      request.frame() === this.#mainFrame
    );
  }

  #where(url: URL): string {
    return `${url.origin === this.origin ? "" : url.host}${url.pathname}`;
  }

  #write(response: Response, url: URL): void {
    const method = response.request().method();
    const status = response.status();
    if (READS.has(method) || status >= 400) return;
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

  #push(kind: OracleEvent["kind"], message: string): void {
    const bounded = message.slice(0, 500);
    this.#events.push({
      kind,
      message: bounded,
      signature: `${kind}: ${signature(bounded, this.origin)}`,
    });
  }

  /** Events so far, after any response bodies still being read. */
  async drain(): Promise<OracleEvent[]> {
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

/** Strip what varies between occurrences of the same failure. */
export function signature(message: string, origin: string): string {
  return message
    .split(origin)
    .join("")
    .replace(/\s+at .*$/gsu, "")
    .replace(/\d+/gu, "#")
    .slice(0, 200);
}
