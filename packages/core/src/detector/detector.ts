import { createHash } from "node:crypto";
import type { BrowserPage } from "../browser-driver.js";
import { quietPage, visibleText } from "../page-bridge.js";
import { isRunWideProviderError, type ProviderCall } from "../provider.js";
import {
  DEFAULT_ALLOW,
  allowed,
  parseAllowRule,
  signalDetection,
  textDetections,
  uniqueDetections,
  type AllowRule,
  type Detection,
} from "./checks.js";
import {
  DEFAULT_SEMANTIC_THRESHOLDS,
  semanticDetections,
  type InspectedPage,
  type PageInspection,
  type PageInspector,
  type SemanticCheck,
  type SemanticThresholds,
} from "./semantic.js";

export interface BugDetectorOptions {
  /** Ask the model about each new page state; omit for browser and text checks only. */
  readonly semantic?: {
    readonly inspector: PageInspector;
    readonly thresholds?: Partial<SemanticThresholds>;
  };
  /** Extra allow rules, added to `DEFAULT_ALLOW`. */
  readonly allow?: readonly string[];
  /** Longest wait for in-flight requests before a step's signals are read. */
  readonly settleMs?: number;
  /** How long a page that looks like it is loading may stay unchanged before it counts as stuck. */
  readonly stuckMs?: number;
}

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

export interface StepInspection {
  readonly detections: readonly Detection[];
  readonly calls: readonly DetectorCall[];
  /** Raw model answers for this step's new states, for evaluation. */
  readonly inspections: readonly StateInspection[];
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

const MODEL_TEXT_LIMIT = 6000;
const QUIET_MS = 80;
const QUIET_TIMEOUT_MS = 2_000;
const POLL_MS = 250;
const LOADING_ROUNDS = 3;
const EMPTY: StepInspection = { detections: [], calls: [], inspections: [] };

function clipText(text: string): string {
  const points = Array.from(text);
  return points.length > MODEL_TEXT_LIMIT
    ? points.slice(0, MODEL_TEXT_LIMIT).join("")
    : text;
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
 * Flags pages that look broken without authored properties. Browser signals
 * are drained per step. Exact text and model checks run once per new page
 * state; model answers are cached run-wide by a hash of the state.
 */
export class BugDetector {
  private readonly allow: readonly AllowRule[];
  private readonly thresholds: SemanticThresholds;
  private readonly inspector: PageInspector | null;
  private readonly settleMs: number;
  private readonly stuckMs: number;
  private readonly cache = new Map<string, Promise<PageInspection>>();
  private readonly seen = new WeakMap<BrowserPage, Set<string>>();
  private semanticStopped = false;

  constructor(options: BugDetectorOptions = {}) {
    this.allow = [...DEFAULT_ALLOW, ...(options.allow ?? [])].map(
      parseAllowRule,
    );
    this.thresholds = {
      ...DEFAULT_SEMANTIC_THRESHOLDS,
      ...options.semantic?.thresholds,
    };
    this.inspector = options.semantic?.inspector ?? null;
    this.settleMs = options.settleMs ?? 1_500;
    this.stuckMs = options.stuckMs ?? 3_000;
  }

  get semantic(): boolean {
    return this.inspector !== null;
  }

  /** Never throws: a detector fault must not change a step's outcome. */
  async inspectStep(
    page: BrowserPage,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<StepInspection> {
    if (options.signal?.aborted) return EMPTY;
    try {
      if (!page.closed)
        await quietPage(page, QUIET_MS, QUIET_TIMEOUT_MS).catch(
          () => undefined,
        );
      const browser = await this.browserDetections(page);
      const found = page.closed
        ? EMPTY
        : await this.pageDetections(page, options);
      return {
        ...found,
        detections: uniqueDetections([...browser, ...found.detections]).filter(
          (detection) => !allowed(detection, this.allow),
        ),
      };
    } catch {
      return EMPTY;
    }
  }

  private async browserDetections(page: BrowserPage): Promise<Detection[]> {
    const source = page.signals?.() ?? null;
    if (!source) return [];
    if (!page.closed) await source.settle({ maxMs: this.settleMs });
    return source.drain().map(signalDetection);
  }

  private async pageDetections(
    page: BrowserPage,
    options: { readonly signal?: AbortSignal },
  ): Promise<StepInspection> {
    const state = await this.readState(page);
    if (!state || !this.firstVisit(page, state)) return EMPTY;
    const collected: Collected = {
      calls: [],
      inspections: [],
      ...(options.signal ? { signal: options.signal } : {}),
    };
    if (!this.inspector || this.semanticStopped)
      return { ...collected, detections: textDetections(state.fullText) };
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
      const answer = await this.inspect(state, collected);
      if (!answer) return textDetections(state.fullText);
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
    answer: { inspection: PageInspection; cached: boolean },
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

  private async inspect(
    state: PageState,
    collected: Collected,
  ): Promise<{ inspection: PageInspection; cached: boolean } | null> {
    const cached = this.cache.get(state.key);
    const started = performance.now();
    const pending =
      cached ??
      this.inspector!.inspectPage(
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
      if (isRunWideProviderError(error)) this.semanticStopped = true;
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
    return { key, page: { path, title, text: clipText(text) }, fullText: text };
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
