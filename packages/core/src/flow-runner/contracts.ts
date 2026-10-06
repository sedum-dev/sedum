import type { VerifyPolicy } from "../assertion-engine.js";
import type { BrowserDriver, BrowserKind } from "../browser-driver.js";
import type {
  ClassificationCache,
  ClassificationProvider,
} from "../classification.js";
import type { CacheStore } from "../cache-store.js";
import type { GoalPlanner } from "../goal-runner.js";
import type { RejectionRouter } from "../script-rejections.js";
import type { VisionResolver } from "../vision.js";
import type { FlowSource } from "../flow-types.js";
import type { Judge, Resolver } from "../provider.js";
import type { ReportPrivacy } from "../report-privacy.js";
import type { ResultFrame } from "../run-result.js";
import type { RunRecorder, TestRecording } from "../run-recorder.js";

export type FlowRunResult =
  | { readonly status: "passed"; readonly file: string }
  | {
      readonly status: "failed";
      readonly file: string;
      readonly source: FlowSource;
      /** Goal failures must not restart autonomous actions through CLI retries. */
      readonly retryable?: false;
    }
  | {
      readonly status: "could_not_run";
      readonly file: string;
      readonly code: string;
      readonly message: string;
      readonly source?: FlowSource;
      readonly fix?: string;
    };

/** Dependencies are injected so the engine never owns process state or SDK types. */
export interface FlowRunnerDependencies {
  readonly repoRoot: string;
  /** Parallel lanes pass a `ReusableBrowserDriver` so attempts share one browser. */
  readonly browser: BrowserDriver;
  readonly provider: ClassificationProvider &
    Resolver &
    Judge &
    Partial<GoalPlanner>;
  readonly visionResolver?: VisionResolver;
  readonly classificationCache: ClassificationCache;
  readonly locatorCache?: CacheStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly headless?: boolean;
  readonly browserKind?: BrowserKind;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly verifyPolicy?: VerifyPolicy;
  readonly verifyGraceMs?: number;
  readonly baseUrl?: string;
  readonly urlOverride?: string;
  readonly slowMoMs?: number;
  readonly headedOverlay?: boolean;
  readonly signal?: AbortSignal;
  readonly rejections?: RejectionRouter;
  readonly report?: {
    readonly recorder: RunRecorder;
    readonly slot?: { readonly ordinal: number; readonly lane?: number };
    readonly privacy: ReportPrivacy;
    readonly evidenceEnabled: boolean;
    readonly replay: boolean;
    readonly saveFrame: (
      attempt: { readonly id: string; readonly ordinal: number },
      frameId: string,
      bytes: Uint8Array,
    ) => Promise<ResultFrame>;
  };
}

type RunReport = NonNullable<FlowRunnerDependencies["report"]>;

/** One attempt's report: its own test handle and its own privacy state. */
export type AttemptReport = Omit<RunReport, "recorder" | "slot"> & {
  readonly test: TestRecording;
};

/** Shared with the script runner. */
export type AttemptDependencies = Omit<FlowRunnerDependencies, "report"> & {
  readonly report?: AttemptReport;
};
