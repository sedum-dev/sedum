import type { ProviderCall } from "../provider.js";
import { routeTemplate } from "./archive.js";
import type { ExploreResult } from "./explorer.js";
import type {
  ExploreAction,
  ExploreFailure,
  ExploreMode,
  ExploreSafety,
  TraceEntry,
} from "./types.js";

/** A target's box as fractions (0-1) of the viewport, as frames record it. */
export interface FrameBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Frames of one step, relative to the run directory. */
export interface StepFrames {
  /** The page as the action was about to run, with the target's box. */
  readonly before?: string;
  readonly box?: FrameBox;
  /** The page once the step settled. */
  readonly after?: string;
}

/** The test `--shrink` wrote for a finding, or why there is none. */
export type FindingTest =
  | {
      readonly path: string;
      readonly yaml: string;
      readonly actionsBefore: number;
      readonly actionsAfter: number;
      /** Whether replaying the emitted sentences showed the failure again. */
      readonly reproduced: boolean;
      readonly sentences: {
        readonly matched: number;
        readonly located: number;
      };
    }
  | { readonly notShrunk: string };

/** One distinct failure signature, at the first step that showed it. */
export interface ExploreFinding {
  /** F1, F2, … in the order the walk met them. */
  readonly id: string;
  readonly signature: string;
  readonly kind: ExploreFailure["kind"];
  /** Untrusted page or browser text. */
  readonly message: string;
  readonly step: number;
  readonly route: string;
  readonly test?: FindingTest;
}

/** One action of the walk, for the report's timeline. */
export interface ExploreStepView {
  readonly step: number;
  readonly route: string;
  readonly pageKind?: string;
  readonly action: string;
  readonly outcome: TraceEntry["outcome"];
  /** Part of a form completion or a return, rather than a fresh pick. */
  readonly planned: boolean;
  readonly signatures: readonly string[];
  readonly writes: readonly string[];
  readonly frames?: StepFrames;
}

/**
 * `result.json` of `sedum explore`: what the walk did, what it found, what
 * it changed on the server and what Jev cost. Experimental, version 1.
 */
export interface ExploreRunResult {
  readonly sedumExplore: 1;
  readonly runId: string;
  readonly startUrl: string;
  readonly seed: number;
  readonly mode: ExploreMode;
  readonly safety: ExploreSafety;
  readonly detect: "browser" | "semantic";
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: { readonly requested: number; readonly taken: number };
  readonly stopReason: string | null;
  readonly verdict: "findings" | "clean";
  readonly findings: readonly ExploreFinding[];
  readonly coverage: {
    readonly states: number;
    readonly routes: readonly {
      readonly route: string;
      readonly visits: number;
    }[];
    readonly pageKinds: Readonly<Record<string, number>>;
  };
  readonly writes: readonly {
    readonly endpoint: string;
    readonly count: number;
    readonly firstStep: number;
  }[];
  /** Targets the walk would not click: session-ending, or judged destructive. */
  readonly skipped: readonly string[];
  readonly jev: {
    readonly calls: number;
    readonly inputTokens: number;
    /** Null when any call's cost was unknown. */
    readonly costUsd: number | null;
    readonly latencyMs: { readonly p50: number; readonly p95: number } | null;
    readonly errors: readonly string[];
  };
  readonly timeline: readonly ExploreStepView[];
  readonly artifacts: {
    /** The run directory as the command was given it; other paths are inside it. */
    readonly directory: string;
    readonly trace: string;
    readonly frames: boolean;
    readonly tests: readonly string[];
  };
}

export interface ExploreRunMeta {
  readonly runId: string;
  readonly startedAt: string;
  readonly requestedSteps: number;
  readonly safety: ExploreSafety;
  readonly detect: "browser" | "semantic";
  readonly trace: string;
  /** The run directory, relative to where the command ran. */
  readonly directory: string;
  /** Frames by step, when the run captured them (`--replay`). */
  readonly frames?: ReadonlyMap<number, StepFrames>;
  /** Tests `--shrink` wrote, by finding signature. */
  readonly tests?: ReadonlyMap<string, FindingTest>;
  /** Extra calls, such as the locator round-trips of `--shrink`. */
  readonly extraCalls?: readonly ProviderCall[];
}

export function describeAction(action: ExploreAction): string {
  if (action.kind === "click")
    return `click ${action.target.role || "element"} "${action.target.name}"${action.option ? ` = "${action.option}"` : ""}`;
  if (action.kind === "type")
    return `type "${action.value.slice(0, 60)}" into "${action.target.name}"`;
  if (action.kind === "press") return `press ${action.key}`;
  if (action.kind === "goto") return `go to ${action.url}`;
  if (action.kind === "scroll") return `scroll ${action.direction}`;
  if (action.kind === "wait") return `wait ${action.ms} ms`;
  return action.kind;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function jevReceipt(result: ExploreResult, extra: readonly ProviderCall[]) {
  const calls = [...result.calls, ...result.measurementCalls, ...extra];
  const unknown = calls.some((c) => c.totalCostUsd === null);
  return {
    calls: calls.length,
    inputTokens: calls.reduce((sum, c) => sum + c.usage.inputTokens, 0),
    costUsd: unknown
      ? null
      : calls.reduce((sum, c) => sum + (c.totalCostUsd ?? 0), 0),
    latencyMs: result.advisorMs.length
      ? {
          p50: percentile(result.advisorMs, 0.5),
          p95: percentile(result.advisorMs, 0.95),
        }
      : null,
    errors: [...new Set(result.advisorErrors)],
  };
}

function routeVisits(trace: readonly TraceEntry[]) {
  const visits = new Map<string, number>();
  for (const entry of trace) {
    const route = routeTemplate(entry.route);
    visits.set(route, (visits.get(route) ?? 0) + 1);
  }
  return [...visits.entries()]
    .map(([route, count]) => ({ route, visits: count }))
    .sort((a, b) => b.visits - a.visits);
}

function writeLog(trace: readonly TraceEntry[]) {
  const writes = new Map<string, { count: number; firstStep: number }>();
  for (const entry of trace)
    for (const write of entry.writes ?? []) {
      const key = `${write.method} ${write.endpoint}`;
      const seen = writes.get(key);
      if (seen) seen.count++;
      else writes.set(key, { count: 1, firstStep: entry.step });
    }
  return [...writes.entries()].map(([endpoint, w]) => ({ endpoint, ...w }));
}

function findingsOf(
  result: ExploreResult,
  tests: ReadonlyMap<string, FindingTest> | undefined,
): ExploreFinding[] {
  return result.failures.map((failure, index) => {
    const entry = result.trace.find((e) => e.step === failure.step);
    const test = tests?.get(failure.signature);
    return {
      id: `F${index + 1}`,
      signature: failure.signature,
      kind: failure.kind,
      message: failure.message,
      step: failure.step,
      route: entry?.route ?? "",
      ...(test ? { test } : {}),
    };
  });
}

function timelineOf(
  trace: readonly TraceEntry[],
  frames: ReadonlyMap<number, StepFrames> | undefined,
): ExploreStepView[] {
  return trace.map((entry) => {
    const stepFrames = frames?.get(entry.step);
    return {
      step: entry.step,
      route: entry.route,
      ...(entry.pageKind ? { pageKind: entry.pageKind } : {}),
      action: describeAction(entry.action),
      outcome: entry.outcome,
      planned: entry.why.planned === true,
      signatures: entry.events.map((e) => e.signature),
      writes: (entry.writes ?? []).map((w) => `${w.method} ${w.endpoint}`),
      ...(stepFrames ? { frames: stepFrames } : {}),
    };
  });
}

/** The run's `result.json`, from the walk and what the command added. */
export function buildExploreRunResult(
  result: ExploreResult,
  meta: ExploreRunMeta,
): ExploreRunResult {
  const tests = [...(meta.tests?.values() ?? [])].flatMap((t) =>
    "path" in t ? [t.path] : [],
  );
  return {
    sedumExplore: 1,
    runId: meta.runId,
    startUrl: result.startUrl,
    seed: result.seed,
    mode: result.mode,
    safety: meta.safety,
    detect: meta.detect,
    startedAt: meta.startedAt,
    durationMs: Math.round(result.elapsedMs),
    steps: { requested: meta.requestedSteps, taken: result.trace.length },
    stopReason: result.stopReason ?? null,
    verdict: result.failures.length ? "findings" : "clean",
    findings: findingsOf(result, meta.tests),
    coverage: {
      states: result.states,
      routes: routeVisits(result.trace),
      pageKinds: result.kinds,
    },
    writes: writeLog(result.trace),
    skipped: result.skippedDestructive,
    jev: jevReceipt(result, meta.extraCalls ?? []),
    timeline: timelineOf(result.trace, meta.frames),
    artifacts: {
      directory: meta.directory,
      trace: meta.trace,
      frames: !!meta.frames?.size,
      tests,
    },
  };
}
