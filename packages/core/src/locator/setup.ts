import type { BrowserPage } from "../browser-driver.js";
import type { CacheStore } from "../cache-store.js";
import {
  matchEntry,
  pageKey,
  type CacheEntry,
  type CacheMissReason,
} from "../page-cache.js";
import { pageVersion } from "../page-bridge.js";
import {
  codePoints,
  type Candidate,
  type CandidatePage,
  type PageVersion,
} from "../page-protocol.js";
import { fullSet, sameVersion } from "./candidates.js";
import type {
  LocatorCacheDiagnostic,
  LocatorOptions,
  LocatorResult,
} from "./types.js";
import type { ProviderCall } from "../provider.js";
import { ResolvedStepTarget } from "../step-executor.js";

const MAX_SENTENCE_POINTS = 512;

export function validLocatorInput(options: LocatorOptions): boolean {
  return !(
    !options.sentence.trim() ||
    codePoints(options.sentence) > MAX_SENTENCE_POINTS ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
  );
}

export class LocatorLifecycle {
  readonly controller = new AbortController();
  private readonly onAbort = () => this.controller.abort();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: LocatorOptions) {
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.controller.abort();
    this.timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => this.controller.abort(), options.timeoutMs);
  }

  ensureActive(): void {
    if (this.controller.signal.aborted) throw new Error("locator_aborted");
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.options.signal?.removeEventListener("abort", this.onAbort);
  }
}

interface SetupContext {
  readonly page: BrowserPage;
  readonly options: LocatorOptions;
  readonly calls: ProviderCall[];
  readonly ensureActive: () => void;
  readonly observed: (version: PageVersion) => void;
}

export type LocatorSetupResult =
  | {
      readonly kind: "ready";
      readonly source: CandidatePage;
      readonly cacheSentence: string;
      readonly cacheOutcome?: LocatorCacheDiagnostic;
      readonly storedEntry?: CacheEntry;
    }
  | {
      readonly kind: "cache_hit";
      readonly result: LocatorResult;
    }
  | {
      readonly kind: "stale";
      readonly source: CandidatePage;
      readonly cacheOutcome: LocatorCacheDiagnostic;
    };

async function observeCandidates(
  context: SetupContext,
): Promise<CandidatePage> {
  const { page, options, ensureActive } = context;
  let source = await fullSet(page, options.operation);
  context.observed(source.version);
  ensureActive();
  if (options.operation !== "fill" || source.candidates.length > 0)
    return source;
  const deadline = performance.now() + 1_500;
  while (source.candidates.length === 0 && performance.now() < deadline) {
    ensureActive();
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    source = await fullSet(page, "fill");
  }
  return source.candidates.length === 0 ? await fullSet(page, "click") : source;
}

function cacheDiagnostic(
  outcome: LocatorCacheDiagnostic["outcome"],
  reason: LocatorCacheDiagnostic["reason"],
): LocatorCacheDiagnostic {
  return {
    outcome,
    reason,
    fallbackCalledModel: false,
    targetChanged: false,
  };
}

interface CacheSetupContext extends SetupContext {
  readonly source: CandidatePage;
  readonly cacheSentence: string;
  readonly store: CacheStore;
  readonly key: Uint8Array;
}

async function setupKeylessCache(
  store: CacheStore,
  source: CandidatePage,
  cacheSentence: string,
): Promise<LocatorSetupResult> {
  const bypass = await store
    .lookup("")
    .catch(() => ({ reason: "storage_error" as const }));
  const failed =
    "reason" in bypass &&
    (bypass.reason === "storage_error" || bypass.reason === "corrupt");
  return {
    kind: "ready",
    source,
    cacheSentence,
    cacheOutcome: cacheDiagnostic(
      failed ? "miss" : "bypassed",
      "reason" in bypass ? bypass.reason : "disabled",
    ),
  };
}

function shouldInvalidate(reason: CacheMissReason): boolean {
  return !["absent", "storage_error", "candidate_set_incomplete"].includes(
    reason,
  );
}

async function setupKeyedCache(
  context: CacheSetupContext,
): Promise<LocatorSetupResult> {
  const { options, source, cacheSentence, store, key } = context;
  const digest = pageKey(
    key,
    source.version.route,
    options.operation,
    cacheSentence,
  );
  const lookup = await store
    .lookup(digest)
    .catch(() => ({ reason: "storage_error" as const }));
  const storedEntry = "entry" in lookup ? lookup.entry : undefined;
  const matched =
    "reason" in lookup
      ? { hit: false as const, reason: lookup.reason }
      : matchEntry(
          storedEntry,
          key,
          source.version.route,
          options.operation,
          cacheSentence,
          source.candidates,
          true,
          options.runtimeDependent,
        );
  if (!matched.hit) {
    return setupCacheMiss(context, digest, storedEntry, matched.reason);
  }
  return setupCacheHit(context, matched.candidate);
}

async function setupCacheMiss(
  context: CacheSetupContext,
  digest: string,
  storedEntry: CacheEntry | undefined,
  reason: CacheMissReason,
): Promise<LocatorSetupResult> {
  if (shouldInvalidate(reason))
    await context.store.invalidate(digest, storedEntry).catch(() => undefined);
  return {
    kind: "ready",
    source: context.source,
    cacheSentence: context.cacheSentence,
    cacheOutcome: cacheDiagnostic("miss", reason),
    ...(storedEntry ? { storedEntry } : {}),
  };
}

async function setupCacheHit(
  context: CacheSetupContext,
  candidate: Candidate,
): Promise<LocatorSetupResult> {
  const { page, calls, source } = context;
  if (!sameVersion(await pageVersion(page), source.version)) {
    return {
      kind: "stale",
      source,
      cacheOutcome: cacheDiagnostic("miss", "candidate_set_incomplete"),
    };
  }
  return {
    kind: "cache_hit",
    result: {
      kind: "resolved",
      target: new ResolvedStepTarget({
        ref: candidate.ref,
        version: source.version,
        tag: candidate.tag,
        name: candidate.name,
      }),
      diagnostic: {
        candidateCount: source.candidates.length,
        rounds: 0,
        confidence: null,
        observationVersion: source.version,
        topOptions: [],
      },
      calls,
      cache: cacheDiagnostic("hit", null),
    },
  };
}

export async function prepareLocator(
  context: SetupContext,
): Promise<LocatorSetupResult> {
  const { options, ensureActive } = context;
  ensureActive();
  const source = await observeCandidates(context);
  context.observed(source.version);
  ensureActive();
  const cacheSentence = options.cacheSentence ?? options.sentence;
  if (!options.cache) return { kind: "ready", source, cacheSentence };

  const store = options.cache;
  if (!store.key) return setupKeylessCache(store, source, cacheSentence);
  if (options.runtimeDependent) {
    return {
      kind: "ready",
      source,
      cacheSentence,
      cacheOutcome: cacheDiagnostic("bypassed", "runtime_dependent"),
    };
  }

  return setupKeyedCache({
    ...context,
    source,
    cacheSentence,
    store,
    key: store.key,
  });
}
