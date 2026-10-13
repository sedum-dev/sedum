import type { BrowserPage } from "../browser-driver.js";
import { quietPage } from "../page-bridge.js";
import {
  DEFAULT_ALLOW,
  allowed,
  parseAllowRule,
  signalDetection,
  uniqueDetections,
  type AllowRule,
  type Detection,
} from "./checks.js";
import {
  NO_PAGE_FINDINGS,
  PageChecks,
  type PageChecksOptions,
  type PageFindings,
} from "./page-checks.js";

export interface BugDetectorOptions {
  /** Also ask Jev about each new page state (`--detect semantic`). */
  readonly semantic?: PageChecksOptions;
  /** Extra allow rules, added to `DEFAULT_ALLOW`. */
  readonly allow?: readonly string[];
  /** Longest wait for in-flight requests before a step's signals are read. */
  readonly settleMs?: number;
}

/** A step's findings, the Jev calls they cost, and Jev's raw answers. */
export type StepInspection = PageFindings;

const QUIET_MS = 80;
const QUIET_TIMEOUT_MS = 2_000;

/**
 * Flags steps whose page reported a console error, an uncaught exception, an
 * unhandled rejection, or an HTTP error, without authored claims. Signals are
 * drained per step, after the page and its requests settle, so each finding
 * lands on the step that caused it. With `semantic`, Jev also checks each new
 * page state for errors, stuck loading, empty sections, and broken values.
 */
export class BugDetector {
  private readonly allow: readonly AllowRule[];
  private readonly settleMs: number;
  private readonly pageChecks: PageChecks | null;

  constructor(options: BugDetectorOptions = {}) {
    this.allow = [...DEFAULT_ALLOW, ...(options.allow ?? [])].map(
      parseAllowRule,
    );
    this.settleMs = options.settleMs ?? 1_500;
    this.pageChecks = options.semantic
      ? new PageChecks(options.semantic)
      : null;
  }

  /** Never throws: a detector fault must not change a step's outcome. */
  async inspectStep(
    page: BrowserPage,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<StepInspection> {
    if (options.signal?.aborted) return NO_PAGE_FINDINGS;
    try {
      const source = page.signals?.() ?? null;
      if (!source) return NO_PAGE_FINDINGS;
      if (!page.closed) {
        await quietPage(page, QUIET_MS, QUIET_TIMEOUT_MS).catch(
          () => undefined,
        );
        await source.settle({ maxMs: this.settleMs });
      }
      const found =
        this.pageChecks && !page.closed
          ? await this.pageChecks.inspect(page, options.signal)
          : NO_PAGE_FINDINGS;
      // A stuck-loading wait can outlast requests the step started; let them land here.
      if (found.inspections.some((state) => state.waited) && !page.closed)
        await source.settle({ maxMs: this.settleMs });
      // Drained last, so signals raised while Jev answered belong to this step.
      const signals = source.drain().map(signalDetection);
      return {
        ...found,
        detections: this.reportable([...signals, ...found.detections]),
      };
    } catch {
      return NO_PAGE_FINDINGS;
    }
  }

  private reportable(detections: readonly Detection[]): Detection[] {
    return uniqueDetections(detections).filter(
      (detection) => !allowed(detection, this.allow),
    );
  }
}
