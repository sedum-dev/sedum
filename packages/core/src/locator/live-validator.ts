import type { BrowserPage } from "../browser-driver.js";
import { pageKey, type CacheEntry } from "../page-cache.js";
import { liveCandidates, pageVersion } from "../page-bridge.js";
import {
  type Candidate,
  type CandidatePage,
  type Operation,
} from "../page-protocol.js";
import { MAX_CANDIDATES, sameVersion } from "./candidates.js";
import {
  exactNameRequested,
  provedTargetChange,
  sameChoiceSurface,
  sameIdentity,
  sameNodeControl,
} from "./identity.js";
import type {
  LocatorCacheDiagnostic,
  LocatorDiagnostic,
  LocatorResult,
} from "../locator.js";
import type { ProviderCall } from "../provider.js";
import { ResolvedStepTarget } from "../step-executor.js";

export interface LiveValidationContext {
  readonly page: BrowserPage;
  readonly operation: Operation;
  readonly sentence: string;
  readonly source: CandidatePage;
  readonly calls: ProviderCall[];
  readonly cacheKey?: Uint8Array;
  readonly cacheSentence: string;
  readonly runtimeDependent?: boolean | undefined;
  readonly storedEntry?: CacheEntry | undefined;
  readonly ensureActive: () => void;
  readonly unresolved: (reason: "stale") => LocatorResult;
  readonly diagnostic: () => LocatorDiagnostic;
  readonly cacheOutcome: () => LocatorCacheDiagnostic | undefined;
  readonly updateCacheOutcome: (value: LocatorCacheDiagnostic) => void;
}

function stableSnapshot(fresh: CandidatePage, source: CandidatePage): boolean {
  return (
    fresh.complete &&
    fresh.total <= MAX_CANDIDATES &&
    fresh.total === fresh.candidates.length &&
    fresh.version.document === source.version.document &&
    fresh.version.route === source.version.route
  );
}

function namedOnce(
  candidates: readonly Candidate[],
  selected: Candidate,
): boolean {
  return (
    candidates.filter(
      (candidate) =>
        candidate.name === selected.name && candidate.role === selected.role,
    ).length === 1
  );
}

function identityMatches(
  context: LiveValidationContext,
  selected: Candidate,
  fresh: CandidatePage,
): Candidate[] {
  if (sameChoiceSurface(context.source.candidates, fresh.candidates))
    return fresh.candidates.filter((candidate) =>
      sameIdentity(selected, candidate),
    );
  if (
    !namedOnce(context.source.candidates, selected) ||
    !namedOnce(fresh.candidates, selected)
  )
    return [];
  if (!exactNameRequested(context.sentence, selected)) return [];
  return fresh.candidates.filter((candidate) =>
    sameNodeControl(selected, candidate),
  );
}

export class LiveTargetValidator {
  constructor(private readonly context: LiveValidationContext) {}

  async refresh(selected: Candidate, visual = false): Promise<LocatorResult> {
    const fresh = await this.readFresh();
    if (!(await this.isValidSnapshot(fresh, visual)))
      return this.context.unresolved("stale");
    const matches = identityMatches(this.context, selected, fresh);
    if (matches.length !== 1) return this.context.unresolved("stale");
    this.context.ensureActive();
    this.markTargetChange(matches[0]!, fresh);
    return this.resolved(matches[0]!, fresh, visual);
  }

  private async readFresh(): Promise<CandidatePage> {
    this.context.ensureActive();
    const fresh = await liveCandidates(
      this.context.page,
      this.context.operation,
    );
    this.context.ensureActive();
    return fresh;
  }

  private async isValidSnapshot(
    fresh: CandidatePage,
    visual: boolean,
  ): Promise<boolean> {
    if (visual && !sameVersion(fresh.version, this.context.source.version))
      return false;
    if (!stableSnapshot(fresh, this.context.source)) return false;
    return sameVersion(await pageVersion(this.context.page), fresh.version);
  }

  private markTargetChange(candidate: Candidate, fresh: CandidatePage): void {
    const context = this.context;
    const outcome = context.cacheOutcome();
    if (outcome?.outcome !== "miss") return;
    if (!context.storedEntry) return;
    if (!context.cacheKey) return;
    if (
      !provedTargetChange(
        context.storedEntry,
        candidate,
        fresh.candidates,
        context.cacheKey,
      )
    )
      return;
    context.updateCacheOutcome({ ...outcome, targetChanged: true });
  }

  private resolved(
    candidate: Candidate,
    fresh: CandidatePage,
    visual: boolean,
  ): LocatorResult {
    const context = this.context;
    const cacheOutcome = context.cacheOutcome();
    return {
      kind: "resolved",
      target: new ResolvedStepTarget({
        ref: candidate.ref,
        version: fresh.version,
        tag: candidate.tag,
        name: candidate.name,
      }),
      diagnostic: context.diagnostic(),
      calls: context.calls,
      ...(cacheOutcome
        ? {
            cache: {
              ...cacheOutcome,
              fallbackCalledModel: context.calls.length > 0,
            },
          }
        : {}),
      ...this.cacheSeed(candidate, fresh, visual, cacheOutcome),
    };
  }

  private cacheSeed(
    candidate: Candidate,
    fresh: CandidatePage,
    visual: boolean,
    outcome?: LocatorCacheDiagnostic,
  ) {
    const context = this.context;
    if (visual) return {};
    if (!context.cacheKey) return {};
    if (context.runtimeDependent) return {};
    if (outcome?.outcome !== "miss") return {};
    return {
      cacheSeed: {
        candidate,
        eligible: fresh,
        key: pageKey(
          context.cacheKey,
          fresh.version.route,
          context.operation,
          context.cacheSentence,
        ),
      },
    };
  }
}
