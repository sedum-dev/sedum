import type { BrowserPage } from "./browser-driver.js";
import {
  collectCandidates,
  liveCandidates,
  pageVersion,
  PageScriptError,
} from "./page-bridge.js";
import {
  CANDIDATE_LIMIT,
  PAGE_PROTOCOL,
  codePoints,
  projectCandidates,
  type Candidate,
  type CandidatePage,
  type Operation,
  type PageVersion,
} from "./page-protocol.js";
import {
  unknownCostCall,
  type ProviderCall,
  type Resolver,
  type ResolverDecision,
} from "./provider.js";
import { ResolvedStepTarget } from "./step-executor.js";

const MAX_CANDIDATES = 4096;
// Leave room for the adapter's question, model, and criteria wrapper.
const MAX_REQUEST_BYTES = 60 * 1024;
const MAX_SENTENCE_POINTS = 512;
const MAX_PARALLEL_CHOICES = 4;
const MIN_CONFIDENCE = 0.3;
const MIN_LEAD = 0.1;
const WEAK_MEMBER_WORDS = new Set([
  "a",
  "add",
  "an",
  "and",
  "article",
  "at",
  "body",
  "button",
  "by",
  "cart",
  "control",
  "entry",
  "field",
  "first",
  "for",
  "from",
  "in",
  "input",
  "item",
  "label",
  "last",
  "link",
  "list",
  "more",
  "of",
  "on",
  "option",
  "or",
  "page",
  "post",
  "product",
  "result",
  "results",
  "story",
  "that",
  "the",
  "thing",
  "this",
  "to",
  "with",
]);

function excerpt(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join("");
}

export type LocatorFailure =
  | "none"
  | "ambiguous"
  | "stale"
  | "no_candidates"
  | "incomplete"
  | "resource_limit"
  | "not_fillable"
  | "provider_error"
  | "request_too_large"
  | "invalid_input"
  | "timeout";

export interface LocatorOptionDiagnostic {
  readonly name: string;
  readonly role: string;
  readonly probability: number;
}
export interface LocatorDiagnostic {
  readonly candidateCount: number;
  readonly rounds: number;
  readonly confidence?: number | null;
  /** Internal accepted candidate-set provenance; never projected into JSON. */
  readonly observationVersion?: PageVersion;
  /** Probabilities come only from the final comparable Choice. */
  readonly topOptions: readonly LocatorOptionDiagnostic[];
  readonly gate?: string;
}
export type LocatorResult =
  | {
      readonly kind: "resolved";
      readonly target: ResolvedStepTarget;
      readonly diagnostic: LocatorDiagnostic;
      readonly calls: readonly ProviderCall[];
    }
  | {
      readonly kind: "unresolved";
      readonly reason: LocatorFailure;
      readonly diagnostic: LocatorDiagnostic;
      readonly calls: readonly ProviderCall[];
    };

export interface LocatorOptions {
  readonly operation: Operation;
  readonly sentence: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Redact sensitive page-derived text only at the Resolver boundary. */
  readonly projectText?: (text: string) => string;
}

class LocatorError extends Error {
  constructor(readonly reason: LocatorFailure) {
    super(reason);
  }
}

function sameVersion(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.route === b.route &&
    a.revision === b.revision
  );
}

async function fullSet(
  page: BrowserPage,
  operation: Operation,
): Promise<CandidatePage> {
  const first = await collectCandidates(page, operation);
  if (
    !first.complete ||
    first.offset !== 0 ||
    first.total > MAX_CANDIDATES ||
    first.candidates.length > CANDIDATE_LIMIT
  )
    throw new LocatorError(
      first.total > MAX_CANDIDATES ? "resource_limit" : "incomplete",
    );
  const collected = [...first.candidates];
  const refs = new Set(collected.map((candidate) => candidate.ref));
  if (refs.size !== collected.length) throw new LocatorError("incomplete");
  let next = first.next;
  while (next !== null) {
    if (next !== collected.length || collected.length >= first.total)
      throw new LocatorError("incomplete");
    const part = await collectCandidates(page, operation, next, first.version);
    if (!sameVersion(part.version, first.version))
      throw new LocatorError("stale");
    if (
      !part.complete ||
      part.total !== first.total ||
      part.offset !== next ||
      part.candidates.length === 0 ||
      part.candidates.length > CANDIDATE_LIMIT
    )
      throw new LocatorError("incomplete");
    for (const candidate of part.candidates) {
      if (refs.has(candidate.ref)) throw new LocatorError("incomplete");
      refs.add(candidate.ref);
      collected.push(candidate);
    }
    next = part.next;
  }
  if (
    collected.length !== first.total ||
    !sameVersion(await pageVersion(page), first.version)
  )
    throw new LocatorError("stale");
  return { ...first, next: null, candidates: collected };
}

function requestOptions(candidates: readonly Candidate[]): CandidatePage {
  return {
    protocol: PAGE_PROTOCOL,
    version: { document: "", route: "", revision: 0 },
    total: candidates.length,
    offset: 0,
    next: null,
    complete: true,
    candidates,
  };
}

function requestBytes(
  sentence: string,
  candidates: readonly Candidate[],
): number {
  let projected: ReturnType<typeof projectCandidates>;
  try {
    projected = projectCandidates(requestOptions(candidates));
  } catch {
    throw new LocatorError("request_too_large");
  }
  return Buffer.byteLength(
    JSON.stringify({
      sentence,
      options: [
        ...projected.map((candidate) => ({ kind: "candidate", candidate })),
        { kind: "none", id: "none" },
      ],
    }),
    "utf8",
  );
}

function batches(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate[][] {
  const result: Candidate[][] = [];
  let batch: Candidate[] = [];
  for (const candidate of candidates) {
    if (
      batch.length &&
      (batch.length === CANDIDATE_LIMIT ||
        requestBytes(sentence, [...batch, candidate]) > MAX_REQUEST_BYTES)
    ) {
      result.push(batch);
      batch = [];
    }
    batch.push(candidate);
    if (requestBytes(sentence, batch) > MAX_REQUEST_BYTES)
      throw new LocatorError("request_too_large");
  }
  if (batch.length) result.push(batch);
  return result;
}

function validateDecision(
  decision: ResolverDecision,
  candidates: readonly Candidate[],
): void {
  const ids = new Set(candidates.map((candidate) => candidate.ref));
  const expected = new Set([...ids, "none"]);
  const probabilities = decision.probabilities;
  const actual = Object.keys(probabilities);
  if (actual.length !== expected.size || actual.some((id) => !expected.has(id)))
    throw new LocatorError("provider_error");
  let total = 0;
  for (const value of Object.values(probabilities)) {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new LocatorError("provider_error");
    total += value;
  }
  if (
    Math.abs(total - 1) > 0.02 ||
    (decision.confidence !== null &&
      (!Number.isFinite(decision.confidence) ||
        decision.confidence < 0 ||
        decision.confidence > 1))
  )
    throw new LocatorError("provider_error");
  const selected =
    decision.selection.kind === "none" ? "none" : decision.selection.id;
  if (
    !expected.has(selected) ||
    probabilities[selected]! + 1e-9 < Math.max(...Object.values(probabilities))
  )
    throw new LocatorError("provider_error");
}

function topOptions(
  decision: ResolverDecision,
  candidates: readonly Candidate[],
): LocatorOptionDiagnostic[] {
  const byId = new Map(
    candidates.map((candidate) => [candidate.ref, candidate]),
  );
  const ranked = Object.entries(decision.probabilities)
    .filter(([id]) => id !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id, probability]) => ({
      name: excerpt(byId.get(id)?.name ?? "", 120),
      role: byId.get(id)?.role ?? "",
      probability,
    }));
  return [
    ...ranked,
    {
      name: "(no match)",
      role: "",
      probability: decision.probabilities.none ?? 0,
    },
  ].sort((a, b) => b.probability - a.probability);
}

function comparableLead(decision: ResolverDecision, id: string): number {
  return (
    decision.probabilities[id]! -
    Math.max(
      0,
      ...Object.entries(decision.probabilities)
        .filter(([other]) => other !== id)
        .map(([, probability]) => probability),
    )
  );
}

function repeatedGroup(
  selected: Candidate,
  candidates: readonly Candidate[],
): Candidate[] {
  const name = selected.name.trim().toLocaleLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.name.trim().toLocaleLowerCase() === name ||
      (!!selected.signals.href &&
        candidate.signals.href === selected.signals.href),
  );
}

function sentenceEvidence(
  sentence: string,
  selected: Candidate,
  group: readonly Candidate[],
): boolean {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const sentenceWords = words(sentence);
  if (
    /\barticle body\b/i.test(sentence) &&
    selected.signals.region === "article-body" &&
    group.filter((candidate) => candidate.signals.region === "article-body")
      .length === 1
  )
    return true;
  const firstStory = (candidate: Candidate): boolean =>
    candidate.peers.some((peer) => /^1[.)]\s/.test(peer));
  const namesRequestedPurpose = (candidate: Candidate): boolean =>
    words(candidate.name).some(
      (word) => !WEAK_MEMBER_WORDS.has(word) && sentenceWords.includes(word),
    );
  if (
    /\b(first|top) story\b/i.test(sentence) &&
    firstStory(selected) &&
    namesRequestedPurpose(selected) &&
    group.filter(
      (candidate) => firstStory(candidate) && namesRequestedPurpose(candidate),
    ).length === 1
  )
    return true;
  const containsPhrase = (
    haystack: readonly string[],
    phrase: readonly string[],
  ) =>
    phrase.length > 0 &&
    haystack.some((_, index) =>
      phrase.every((word, offset) => haystack[index + offset] === word),
    );
  const otherTexts = group
    .filter((candidate) => candidate !== selected)
    .flatMap((candidate) => [candidate.name, ...candidate.peers].map(words));
  return [selected.name, ...selected.peers].some((text) => {
    const phrase = words(text);
    return (
      phrase.some((word) => !WEAK_MEMBER_WORDS.has(word)) &&
      containsPhrase(sentenceWords, phrase) &&
      !otherTexts.some((other) => containsPhrase(other, phrase))
    );
  });
}

function explicitRegionEvidence(
  sentence: string,
  candidate: Candidate,
): boolean {
  if (
    /\barticle body\b/i.test(sentence) &&
    candidate.signals.region !== "article-body"
  )
    return false;
  if (
    /\b(first|top) story\b/i.test(sentence) &&
    !candidate.peers.some((peer) => /^1[.)]\s/.test(peer))
  )
    return false;
  return true;
}

function sameIdentity(a: Candidate, b: Candidate): boolean {
  if (
    a.tag !== b.tag ||
    a.role !== b.role ||
    a.name !== b.name ||
    a.inputType !== b.inputType ||
    a.editable !== b.editable ||
    a.disabled !== b.disabled ||
    a.signals.region !== b.signals.region ||
    JSON.stringify(a.peers) !== JSON.stringify(b.peers)
  )
    return false;
  for (const key of ["hook", "id", "name", "href"] as const) {
    if (a.signals[key] && a.signals[key] !== b.signals[key]) return false;
  }
  return true;
}

/** Resolve a sentence to one fresh page target. No browser action occurs here. */
export async function resolveTarget(
  page: BrowserPage,
  resolver: Resolver,
  options: LocatorOptions,
): Promise<LocatorResult> {
  const calls: ProviderCall[] = [];
  let candidateCount = 0;
  let rounds = 0;
  let top: LocatorOptionDiagnostic[] = [];
  let confidence: number | null = null;
  let observationVersion: PageVersion | undefined;
  let gate: string | undefined;
  const unresolved = (reason: LocatorFailure): LocatorResult => ({
    kind: "unresolved",
    reason,
    diagnostic: {
      candidateCount,
      rounds,
      confidence,
      ...(observationVersion ? { observationVersion } : {}),
      topOptions: top,
      ...(gate ? { gate } : {}),
    },
    calls,
  });
  if (
    !options.sentence.trim() ||
    codePoints(options.sentence) > MAX_SENTENCE_POINTS ||
    (options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
  )
    return unresolved("invalid_input");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), options.timeoutMs);
  const ensureActive = () => {
    if (controller.signal.aborted) throw new LocatorError("timeout");
  };
  try {
    ensureActive();
    let source = await fullSet(page, options.operation);
    observationVersion = source.version;
    ensureActive();
    if (options.operation === "fill" && source.candidates.length === 0)
      source = await fullSet(page, "click");
    observationVersion = source.version;
    ensureActive();
    const candidates = source.candidates;
    candidateCount = candidates.length;
    if (!candidateCount) return unresolved("no_candidates");
    const byId = new Map(
      candidates.map((candidate) => [candidate.ref, candidate]),
    );
    const choose = async (
      pool: readonly Candidate[],
    ): Promise<ResolverDecision> => {
      ensureActive();
      const decision = await resolver
        .choose(
          options.sentence,
          {
            complete: true,
            options: [
              ...projectCandidates(requestOptions(pool)).map((candidate) => ({
                kind: "candidate" as const,
                candidate: options.projectText
                  ? {
                      ...candidate,
                      name: options.projectText(candidate.name),
                      peers: candidate.peers.map(options.projectText),
                    }
                  : candidate,
              })),
              { kind: "none" as const, id: "none" as const },
            ],
          },
          { signal: controller.signal },
        )
        .catch((error: unknown) => {
          calls.push(unknownCostCall(error));
          throw error;
        });
      calls.push(decision.call);
      ensureActive();
      validateDecision(decision, pool);
      rounds++;
      return decision;
    };
    let pool: Candidate[] = [...candidates];
    let finalists: Candidate[] = [];
    let decision: ResolverDecision;
    while (true) {
      const heats = batches(options.sentence, pool);
      if (heats.length === 1) {
        finalists = heats[0]!;
        decision = await choose(finalists);
        break;
      }
      const reduced: Candidate[] = [];
      for (let index = 0; index < heats.length; index += MAX_PARALLEL_CHOICES) {
        ensureActive();
        const group = heats.slice(index, index + MAX_PARALLEL_CHOICES);
        const settled = await Promise.allSettled(
          group.map((batch) => choose(batch)),
        );
        const failure = settled.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const choices = settled.map(
          (result) =>
            (result as PromiseFulfilledResult<ResolverDecision>).value,
        );
        if (!sameVersion(await pageVersion(page), source.version))
          throw new LocatorError("stale");
        for (let i = 0; i < group.length; i++) {
          const choice = choices[i]!;
          reduced.push(
            ...group[i]!.filter((candidate) => candidate.ref !== "none")
              .sort(
                (a, b) =>
                  choice.probabilities[b.ref]! - choice.probabilities[a.ref]!,
              )
              .slice(0, 2),
          );
        }
      }
      if (reduced.length >= pool.length)
        throw new LocatorError("resource_limit");
      pool = reduced;
    }
    if (!sameVersion(await pageVersion(page), source.version))
      return unresolved("stale");
    top = topOptions(decision, finalists);
    confidence = decision.confidence;
    if (decision.selection.kind === "none") return unresolved("none");
    const selected = byId.get(decision.selection.id);
    if (!selected) return unresolved("provider_error");
    const group = repeatedGroup(selected, candidates);
    const low =
      (decision.confidence !== null && decision.confidence < MIN_CONFIDENCE) ||
      decision.probabilities[selected.ref]! < MIN_CONFIDENCE ||
      comparableLead(decision, selected.ref) < MIN_LEAD;
    if (low) {
      gate = "low_confidence_or_margin";
      if (group.length < 2) return unresolved("ambiguous");
      const groupProbability = group.reduce(
        (sum, candidate) => sum + (decision.probabilities[candidate.ref] ?? 0),
        0,
      );
      if (
        groupProbability < 0.75 ||
        groupProbability - (1 - groupProbability) < 0.2
      ) {
        gate = "repeated_group_weak";
        return unresolved("ambiguous");
      }
      if (batches(options.sentence, group).length !== 1)
        return unresolved("ambiguous");
      if (!sameVersion(await pageVersion(page), source.version))
        return unresolved("stale");
      const narrower = await choose(group);
      if (!sameVersion(await pageVersion(page), source.version))
        return unresolved("stale");
      top = topOptions(narrower, group);
      confidence = narrower.confidence;
      if (narrower.selection.kind === "none") return unresolved("none");
      const member = byId.get(narrower.selection.id);
      if (
        !member ||
        narrower.probabilities[member.ref]! < 0.6 ||
        comparableLead(narrower, member.ref) < 0.2
      ) {
        gate = "repeated_member_weak";
        return unresolved("ambiguous");
      }
      if (!sentenceEvidence(options.sentence, member, group)) {
        gate = "repeated_member_no_evidence";
        return unresolved("ambiguous");
      }
      if (!explicitRegionEvidence(options.sentence, member)) {
        gate = "explicit_region_unproven";
        return unresolved("ambiguous");
      }
      gate = "repeated_member_proven";
      if (options.operation === "fill" && !member.editable)
        return unresolved("not_fillable");
      return await refresh(member);
    }
    if (
      group.length > 1 &&
      !sentenceEvidence(options.sentence, selected, group)
    ) {
      gate = "repeated_member_no_evidence";
      return unresolved("ambiguous");
    }
    if (options.operation === "fill" && !selected.editable)
      return unresolved("not_fillable");
    if (!explicitRegionEvidence(options.sentence, selected)) {
      gate = "explicit_region_unproven";
      return unresolved("ambiguous");
    }
    return await refresh(selected);

    async function refresh(
      selectedCandidate: Candidate,
    ): Promise<LocatorResult> {
      ensureActive();
      const fresh = await liveCandidates(page, options.operation);
      ensureActive();
      if (
        !fresh.complete ||
        fresh.total > MAX_CANDIDATES ||
        fresh.total !== fresh.candidates.length ||
        fresh.version.document !== source.version.document ||
        fresh.version.route !== source.version.route ||
        !sameVersion(await pageVersion(page), fresh.version)
      )
        return unresolved("stale");
      const matches = fresh.candidates.filter((candidate) =>
        sameIdentity(selectedCandidate, candidate),
      );
      if (matches.length !== 1) return unresolved("stale");
      if (!explicitRegionEvidence(options.sentence, matches[0]!)) {
        gate = "explicit_region_unproven";
        return unresolved("ambiguous");
      }
      ensureActive();
      return {
        kind: "resolved",
        target: new ResolvedStepTarget({
          ref: matches[0]!.ref,
          version: fresh.version,
          tag: matches[0]!.tag,
          name: matches[0]!.name,
        }),
        diagnostic: {
          candidateCount,
          rounds,
          confidence,
          observationVersion: source.version,
          topOptions: top,
          ...(gate ? { gate } : {}),
        },
        calls,
      };
    }
  } catch (error) {
    if (controller.signal.aborted) return unresolved("timeout");
    if (error instanceof LocatorError) return unresolved(error.reason);
    if (error instanceof PageScriptError) return unresolved("incomplete");
    return unresolved("provider_error");
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
