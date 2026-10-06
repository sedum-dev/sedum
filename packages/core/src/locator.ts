import type { BrowserPage } from "./browser-driver.js";
import { PageScriptError } from "./page-bridge.js";
import type { Candidate, PageVersion } from "./page-protocol.js";
import {
  isRunWideProviderError,
  type ProviderCall,
  type Resolver,
} from "./provider.js";
import { LocatorError } from "./locator/error.js";
import { ItemVerifier } from "./locator/item-verifier.js";
import { LiveTargetValidator } from "./locator/live-validator.js";
import { VisionFallback } from "./locator/vision-fallback.js";
import { eliminateCandidates } from "./locator/elimination.js";
import {
  LocatorLifecycle,
  prepareLocator,
  validLocatorInput,
} from "./locator/setup.js";
import {
  RuntimeSelection,
  type SelectionState,
} from "./locator/runtime-selection.js";
import type {
  LocatorCacheDiagnostic,
  LocatorDiagnostic,
  LocatorFailure,
  LocatorOptions,
  LocatorResult,
} from "./locator/types.js";
export type {
  LocatorCacheDiagnostic,
  LocatorCacheSeed,
  LocatorDiagnostic,
  LocatorFailure,
  LocatorOptionDiagnostic,
  LocatorOptions,
  LocatorResult,
  RepeatedMemberPolicy,
} from "./locator/types.js";

/** Resolve a sentence to one fresh page target. No browser action occurs here. */
export async function resolveTarget(
  page: BrowserPage,
  resolver: Resolver,
  options: LocatorOptions,
): Promise<LocatorResult> {
  const calls: ProviderCall[] = [];
  // Vision resolves ambiguous clicks instead of the default permissive pick.
  // Explicit core policies and all non-vision behavior retain their precedence.
  const repeatedMember = options.repeatedMember ?? {
    modelPick: !(options.visionResolver && options.operation === "click"),
  };
  const verifyItems = options.verifyItems !== false;
  const codeFallback = options.codeFallback !== false;
  let candidateCount = 0;
  let rounds = 0;
  const selection: SelectionState = { top: [], confidence: null };
  let observationVersion: PageVersion | undefined;
  let visionDiagnostic: LocatorDiagnostic["vision"];
  let cacheOutcome: LocatorCacheDiagnostic | undefined;
  let storedEntry;
  let cacheSentence = options.cacheSentence ?? options.sentence;
  const unresolved = (reason: LocatorFailure): LocatorResult => ({
    kind: "unresolved",
    reason,
    diagnostic: {
      candidateCount,
      rounds,
      confidence: selection.confidence,
      ...(observationVersion ? { observationVersion } : {}),
      topOptions: selection.top,
      ...(selection.gate ? { gate: selection.gate } : {}),
      ...(visionDiagnostic ? { vision: visionDiagnostic } : {}),
    },
    calls,
    ...(cacheOutcome
      ? { cache: { ...cacheOutcome, fallbackCalledModel: calls.length > 0 } }
      : {}),
  });
  if (!validLocatorInput(options)) return unresolved("invalid_input");
  const lifecycle = new LocatorLifecycle(options);
  const { controller } = lifecycle;
  const ensureActive = () => lifecycle.ensureActive();
  try {
    const setup = await prepareLocator({
      page,
      options,
      calls,
      ensureActive,
      observed: (version) => {
        observationVersion = version;
      },
    });
    if (setup.kind === "cache_hit") return setup.result;
    cacheOutcome = setup.cacheOutcome;
    if (setup.kind === "stale") return unresolved("stale");
    const { source } = setup;
    cacheSentence = setup.cacheSentence;
    storedEntry = setup.storedEntry;
    const candidates = source.candidates;
    candidateCount = candidates.length;
    if (!candidateCount) return unresolved("no_candidates");
    const diagnostic = (): LocatorDiagnostic => ({
      candidateCount,
      rounds,
      confidence: selection.confidence,
      observationVersion: source.version,
      topOptions: selection.top,
      ...(selection.gate ? { gate: selection.gate } : {}),
      ...(visionDiagnostic ? { vision: visionDiagnostic } : {}),
    });
    const validator = new LiveTargetValidator({
      page,
      operation: options.operation,
      sentence: options.sentence,
      source,
      calls,
      ...(options.cache?.key ? { cacheKey: options.cache.key } : {}),
      cacheSentence,
      runtimeDependent: options.runtimeDependent,
      storedEntry,
      ensureActive,
      unresolved,
      diagnostic,
      cacheOutcome: () => cacheOutcome,
      updateCacheOutcome: (value) => {
        cacheOutcome = value;
      },
    });
    const refresh = (candidate: Candidate, visual = false) =>
      validator.refresh(candidate, visual);
    const vision = new VisionFallback({
      page,
      resolver: options.visionResolver,
      sentence: options.sentence,
      source,
      candidates,
      calls,
      signal: controller.signal,
      projectText: options.projectText,
      clickOperation: options.operation === "click",
      ensureActive,
      unresolved,
      refresh: (candidate, visual) => refresh(candidate, visual),
      gate: () => selection.gate,
      updateGate: (value) => {
        selection.gate = value;
      },
      updateDiagnostic: (value) => {
        visionDiagnostic = value;
      },
    });
    const itemVerifier = new ItemVerifier({
      page,
      resolver,
      sentence: options.sentence,
      version: source.version,
      signal: controller.signal,
      calls,
      projectText: options.projectText,
      failOnProviderError: Boolean(
        options.visionResolver && options.operation === "click",
      ),
      ensureActive,
    });
    const eliminated = await eliminateCandidates({
      page,
      resolver,
      options,
      source,
      calls,
      signal: controller.signal,
      ensureActive,
      roundCompleted: () => rounds++,
    });
    if (eliminated.stale) return unresolved("stale");
    return await new RuntimeSelection({
      page,
      options,
      source,
      elimination: eliminated,
      state: selection,
      repeatedMember,
      verifyItems: verifyItems && Boolean(resolver.verifyItems),
      codeFallback,
      itemVerifier,
      vision,
      unresolved,
      refresh,
    }).resolve();
  } catch (error) {
    if (
      options.cache &&
      !cacheOutcome &&
      error instanceof LocatorError &&
      (error.reason === "incomplete" || error.reason === "resource_limit")
    )
      cacheOutcome = {
        outcome: "miss",
        reason: "candidate_set_incomplete",
        fallbackCalledModel: false,
        targetChanged: false,
      };
    if (controller.signal.aborted) return unresolved("timeout");
    if (isRunWideProviderError(error)) throw error;
    if (error instanceof LocatorError) return unresolved(error.reason);
    if (error instanceof PageScriptError) return unresolved("incomplete");
    return unresolved("provider_error");
  } finally {
    lifecycle.dispose();
  }
}
