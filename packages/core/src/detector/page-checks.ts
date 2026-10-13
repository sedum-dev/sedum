import { createHash } from "node:crypto";
import type { BrowserPage } from "../browser-driver.js";
import { visibleText } from "../page-bridge.js";
import {
  ProviderError,
  isRunWideProviderError,
  unknownCostCall,
  type ProviderCall,
} from "../provider.js";
import { textDetections, type Detection } from "./checks.js";
import {
  DEFAULT_SEMANTIC_THRESHOLDS,
  INSPECTED_PAGE_LIMITS,
  semanticDetections,
  type InspectedPage,
  type PageInspection,
  type PageInspector,
  type SemanticCheck,
  type SemanticThresholds,
} from "./semantic.js";

export interface DetectorCall {
  readonly call: ProviderCall;
  readonly apiMs: number;
}

export interface StateInspection {
  readonly key: string;
  readonly page: InspectedPage;
  readonly inspection: PageInspection;
  readonly cached: boolean;
  /** After a loading-looking answer: whether the page changed within `stuckMs`. */
  readonly waited: "changed" | "unchanged" | null;
}

export interface PageFindings {
  readonly detections: readonly Detection[];
  readonly calls: readonly DetectorCall[];
  /** Raw model answers for this step's new states, for evaluation. */
  readonly inspections: readonly StateInspection[];
}

export interface PageChecksOptions {
  readonly inspector: PageInspector;
  readonly thresholds?: Partial<SemanticThresholds>;
  /** How long a page that looks like it is loading may stay unchanged before it counts as stuck. */
  readonly stuckMs?: number;
}

interface PageState {
  readonly key: string;
  readonly page: InspectedPage;
  readonly fullText: string;
}

interface Collected {
  readonly calls: DetectorCall[];
  readonly inspections: StateInspection[];
  readonly signal?: AbortSignal;
}

type Answer = { readonly inspection: PageInspection; readonly cached: boolean };

const POLL_MS = 250;
const LOADING_ROUNDS = 3;
export const NO_PAGE_FINDINGS: PageFindings = {
  detections: [],
  calls: [],
  inspections: [],
};

/** The model reads at most `limit` code points of each field. */
function clip(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length > limit ? points.slice(0, limit).join("") : text;
}

/** A request that never left the client cost nothing; any other failure may have been billed. */
function mayHaveBilled(error: unknown): boolean {
  return (
    !(error instanceof ProviderError) ||
    error.failedCall !== undefined ||
    error.attempts > 0
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Jev's page checks: one System One call per new page state, cached run-wide
 * by a hash of the path, title, and visible text. Exact-text leaks are kept
 * only when Jev confirms a broken value, and a loading answer counts only if
 * the page stays unchanged for `stuckMs`.
 */
export class PageChecks {
  private readonly inspector: PageInspector;
  private readonly thresholds: SemanticThresholds;
  private readonly stuckMs: number;
  private readonly cache = new Map<string, Promise<PageInspection>>();
  private readonly seen = new WeakMap<BrowserPage, Set<string>>();
  private stopped = false;

  constructor(options: PageChecksOptions) {
    this.inspector = options.inspector;
    this.thresholds = { ...DEFAULT_SEMANTIC_THRESHOLDS, ...options.thresholds };
    this.stuckMs = options.stuckMs ?? 3_000;
  }

  /** Findings for the page's state, the first time this page shows it. */
  async inspect(
    page: BrowserPage,
    signal?: AbortSignal,
  ): Promise<PageFindings> {
    if (this.stopped) return NO_PAGE_FINDINGS;
    const state = await this.readState(page);
    if (!state || !this.firstVisit(page, state)) return NO_PAGE_FINDINGS;
    const collected: Collected = {
      calls: [],
      inspections: [],
      ...(signal ? { signal } : {}),
    };
    const detections = await this.semanticState(page, state, collected);
    return { ...collected, detections };
  }

  /** Re-inspect a page that looks like it is loading until it settles or proves stuck. */
  private async semanticState(
    page: BrowserPage,
    first: PageState,
    collected: Collected,
  ): Promise<Detection[]> {
    let state = first;
    for (let round = 1; ; round++) {
      const answer = await this.ask(state, collected);
      if (!answer) return [];
      const next = await this.afterLoading(page, state, answer, collected);
      if (!next.state || round >= LOADING_ROUNDS)
        return this.stateDetections(state, answer.inspection, next.stuck);
      this.firstVisit(page, next.state);
      state = next.state;
    }
  }

  /** Records one answer; a loading-like page is watched for a change. */
  private async afterLoading(
    page: BrowserPage,
    state: PageState,
    answer: Answer,
    collected: Collected,
  ): Promise<{ state: PageState | null; stuck: boolean }> {
    const loading =
      answer.inspection.probabilities.stuck_loading >=
      this.thresholds.stuck_loading;
    const next = loading
      ? await this.changedState(page, state, collected.signal)
      : null;
    const waited = !loading ? null : next ? "changed" : "unchanged";
    collected.inspections.push({
      key: state.key,
      page: state.page,
      ...answer,
      waited,
    });
    return { state: next, stuck: waited === "unchanged" };
  }

  private stateDetections(
    state: PageState,
    inspection: PageInspection,
    stuck: boolean,
  ): Detection[] {
    const text =
      inspection.probabilities.broken_value >= this.thresholds.confirmText
        ? textDetections(state.fullText)
        : [];
    const skip = new Set<SemanticCheck>();
    if (!stuck) skip.add("stuck_loading");
    // An exact leak was already found in code; the model adds nothing.
    if (text.length) skip.add("broken_value");
    return [...text, ...semanticDetections(inspection, this.thresholds, skip)];
  }

  private async ask(
    state: PageState,
    collected: Collected,
  ): Promise<Answer | null> {
    const cached = this.cache.get(state.key);
    const started = performance.now();
    const pending =
      cached ??
      this.inspector.inspectPage(
        state.page,
        collected.signal ? { signal: collected.signal } : {},
      );
    if (!cached) this.cache.set(state.key, pending);
    try {
      const inspection = await pending;
      if (!cached)
        collected.calls.push({
          call: inspection.call,
          apiMs: performance.now() - started,
        });
      return { inspection, cached: cached !== undefined };
    } catch (error) {
      this.cache.delete(state.key);
      // Like the judge, keep a failed call on the receipt, with unknown cost.
      if (!cached && mayHaveBilled(error))
        collected.calls.push({
          call: unknownCostCall(error),
          apiMs: performance.now() - started,
        });
      // A rejected key or exhausted rate limit would fail every later page too.
      if (isRunWideProviderError(error)) this.stopped = true;
      return null;
    }
  }

  private async changedState(
    page: BrowserPage,
    state: PageState,
    signal?: AbortSignal,
  ): Promise<PageState | null> {
    const deadline = performance.now() + this.stuckMs;
    const waiting = () =>
      performance.now() < deadline && !page.closed && !signal?.aborted;
    while (waiting()) {
      await sleep(POLL_MS);
      const next = await this.readState(page);
      if (next && next.key !== state.key) return next;
    }
    return null;
  }

  private async readState(page: BrowserPage): Promise<PageState | null> {
    const text = await visibleText(page).catch(() => null);
    if (text === null) return null;
    const title = (await page.title?.().catch(() => "")) ?? "";
    const path = pathOf(page.url);
    const key = createHash("sha256")
      .update(`${path}\u0000${title}\u0000${text}`)
      .digest("hex");
    const inspected = {
      path: clip(path, INSPECTED_PAGE_LIMITS.path),
      title: clip(title, INSPECTED_PAGE_LIMITS.title),
      text: clip(text, INSPECTED_PAGE_LIMITS.text),
    };
    return { key, page: inspected, fullText: text };
  }

  /** True the first time this page shows this state. */
  private firstVisit(page: BrowserPage, state: PageState): boolean {
    let seen = this.seen.get(page);
    if (!seen) this.seen.set(page, (seen = new Set()));
    if (seen.has(state.key)) return false;
    seen.add(state.key);
    return true;
  }
}
