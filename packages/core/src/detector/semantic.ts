import type { ProviderCall, ProviderCallOptions } from "../provider.js";
import type { Detection, PageCheck } from "./checks.js";

/** Code-point limits of an inspected page; the detector clips to them and providers enforce them. */
export const INSPECTED_PAGE_LIMITS = {
  path: 512,
  title: 300,
  text: 6000,
} as const;

/** What the model reads: visible text only, never pixels or markup. */
export interface InspectedPage {
  /** URL path without query or fragment. */
  readonly path: string;
  readonly title: string;
  readonly text: string;
}

/** The checks one System One call answers. */
export type SemanticCheck = PageCheck;

/** Independent probabilities from one System One call, plus a severity rubric. */
export interface PageInspection {
  readonly probabilities: Readonly<Record<SemanticCheck, number>>;
  readonly severity: {
    /** Expected level from 0 (works) to 3 (blocking). */
    readonly score: number;
    readonly confidence: number;
    readonly probabilities: readonly number[];
  };
  readonly call: ProviderCall;
}

/** A provider that can answer the detector's page questions. */
export interface PageInspector {
  inspectPage(
    page: InspectedPage,
    options?: ProviderCallOptions,
  ): Promise<PageInspection>;
}

export function isPageInspector(value: unknown): value is PageInspector {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<PageInspector>).inspectPage === "function"
  );
}

/**
 * Jev's probabilities are not calibrated. These defaults come from the
 * fixture evaluation in `scripts/detector-eval.ts`; rerun it before changing them.
 */
export interface SemanticThresholds {
  readonly error_message: number;
  readonly stuck_loading: number;
  readonly empty_content: number;
  readonly broken_value: number;
  /** A model finding also needs this expected severity; 0 disables the gate. */
  readonly minSeverity: number;
  /**
   * An exact-string leak needs at least this broken_value probability when
   * the model runs: docs pages say "undefined" and "NaN" on purpose.
   */
  readonly confirmText: number;
}

export const DEFAULT_SEMANTIC_THRESHOLDS: SemanticThresholds = {
  error_message: 0.6,
  // Low, because a loading answer must also stay unchanged for `stuckMs`.
  stuck_loading: 0.4,
  empty_content: 0.5,
  broken_value: 0.65,
  // The severity score did not separate cosmetic bugs from clean pages.
  minSeverity: 0,
  confirmText: 0.5,
};

const MESSAGES: Record<SemanticCheck, string> = {
  error_message: "Page appears to show an error to the user",
  stuck_loading: "Page appears stuck in a loading state",
  empty_content: "Page appears empty where content is expected",
  broken_value: "Page appears to show a broken or placeholder value",
};

export const SEMANTIC_CHECKS = Object.keys(MESSAGES) as SemanticCheck[];

export function semanticDetections(
  inspection: PageInspection,
  thresholds: SemanticThresholds,
  skip: ReadonlySet<SemanticCheck> = new Set(),
): Detection[] {
  if (inspection.severity.score < thresholds.minSeverity) return [];
  return SEMANTIC_CHECKS.filter(
    (check) =>
      !skip.has(check) && inspection.probabilities[check] >= thresholds[check],
  ).map((check) => ({
    check,
    source: "model",
    message: MESSAGES[check],
    probability: inspection.probabilities[check],
    severity: inspection.severity.score,
  }));
}
