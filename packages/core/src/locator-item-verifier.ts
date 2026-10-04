import type { BrowserPage } from "./browser-driver.js";
import { LocatorError } from "./locator-error.js";
import { sameVersion } from "./locator-candidates.js";
import { pageVersion } from "./page-bridge.js";
import type { Candidate, PageVersion } from "./page-protocol.js";
import {
  unknownCostCall,
  type ItemVerdict,
  type ProviderCall,
  type Resolver,
} from "./provider.js";

const ITEM_TEXT_LIMIT = 300;

export interface ItemVerifierContext {
  readonly page: BrowserPage;
  readonly resolver: Resolver;
  readonly sentence: string;
  readonly version: PageVersion;
  readonly signal: AbortSignal;
  readonly calls: ProviderCall[];
  readonly projectText?: ((text: string) => string) | undefined;
  readonly failOnProviderError: boolean;
  readonly ensureActive: () => void;
}

interface RankedItem {
  readonly member: Candidate;
  readonly score: number;
}

function itemText(
  member: Candidate,
  project: (text: string) => string,
): string {
  const normalized = member.signals.item!.replace(/\s+/g, " ").trim();
  return project(Array.from(normalized).slice(0, ITEM_TEXT_LIMIT).join(""));
}

function rankedItems(
  members: readonly Candidate[],
  verdict: ItemVerdict,
): RankedItem[] | null {
  const ranked = members
    .map((member) => ({ member, score: verdict.scores[member.ref] }))
    .filter((entry): entry is RankedItem => validScore(entry.score))
    .sort((a, b) => b.score - a.score);
  return ranked.length === members.length ? ranked : null;
}

function validScore(score: number | undefined): score is number {
  return (
    typeof score === "number" &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 1
  );
}

function clearWinner(ranked: readonly RankedItem[]): Candidate | null {
  const [best, second] = ranked;
  if (!best) return null;
  if (best.score < 0.6) return null;
  if (best.score - (second?.score ?? 0) < 0.2) return null;
  return best.member;
}

export class ItemVerifier {
  constructor(private readonly context: ItemVerifierContext) {}

  async verify(members: readonly Candidate[]): Promise<Candidate | null> {
    const verdict = await this.request(members);
    if (!verdict) return null;
    const ranked = rankedItems(members, verdict);
    const winner = ranked && clearWinner(ranked);
    if (!winner || !(await this.pageIsCurrent())) return null;
    return winner;
  }

  private async request(
    members: readonly Candidate[],
  ): Promise<ItemVerdict | null> {
    const context = this.context;
    context.ensureActive();
    try {
      const verdict = await context.resolver.verifyItems!(
        context.sentence,
        members.map((member) => ({
          id: member.ref,
          text: itemText(member, context.projectText ?? ((text) => text)),
        })),
        { signal: context.signal },
      );
      context.calls.push(verdict.call);
      context.ensureActive();
      return verdict;
    } catch (error) {
      context.calls.push(unknownCostCall(error));
      context.ensureActive();
      if (context.failOnProviderError) throw new LocatorError("provider_error");
      return null;
    }
  }

  private async pageIsCurrent(): Promise<boolean> {
    return sameVersion(
      await pageVersion(this.context.page),
      this.context.version,
    );
  }
}
