import type { BrowserPage } from "./browser-driver.js";
import type { CacheStore } from "./cache-store.js";
import {
  keyedDigest,
  matchEntry,
  pageKey,
  type CacheEntry,
  type CacheMissReason,
} from "./page-cache.js";
import {
  collectCandidates,
  liveCandidates,
  pageVersion,
  PageScriptError,
} from "./page-bridge.js";
import {
  CANDIDATE_LIMIT,
  NAME_LIMIT,
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
  type ItemVerdict,
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
export interface LocatorCacheDiagnostic {
  readonly outcome: "hit" | "miss" | "bypassed";
  readonly reason: CacheMissReason | null;
  readonly fallbackCalledModel: boolean;
  readonly targetChanged: boolean;
}
export interface LocatorCacheSeed {
  readonly candidate: Candidate;
  readonly eligible: CandidatePage;
  readonly key: string;
}
export type LocatorResult =
  | {
      readonly kind: "resolved";
      readonly target: ResolvedStepTarget;
      readonly diagnostic: LocatorDiagnostic;
      readonly calls: readonly ProviderCall[];
      readonly cache?: LocatorCacheDiagnostic;
      /** Internal pre-action snapshot; only the runner may stage it after success. */
      readonly cacheSeed?: LocatorCacheSeed;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: LocatorFailure;
      readonly diagnostic: LocatorDiagnostic;
      readonly calls: readonly ProviderCall[];
      readonly cache?: LocatorCacheDiagnostic;
    };

export interface LocatorOptions {
  readonly operation: Operation;
  readonly sentence: string;
  /** Target-only sentence for cache keys; Resolver still receives sentence. */
  readonly cacheSentence?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly cache?: CacheStore;
  readonly runtimeDependent?: boolean;
  /** Redact sensitive page-derived text only at the Resolver boundary. */
  readonly projectText?: (text: string) => string;
  /**
   * Experimental: act on the model's top pick even when its probability or
   * lead is low, so the locator gives up only when the model answers none.
   */
  readonly acceptLowConfidence?: boolean;
  /**
   * When to accept the model's pick among repeated elements (same name or
   * destination) whose sentence words do not single it out. Unset acts on
   * the model's pick ({ modelPick: true }): a vague step clicks the likely
   * element, and the test author can add detail. Pass {} for the strict
   * lexical rule.
   */
  readonly repeatedMember?: RepeatedMemberPolicy;
  /**
   * When the sentence names a section ("under Most popular", "in the See
   * also box"), act on the one same-name member whose local section labels
   * hold every qualifying word. On unless set to false.
   */
  readonly sectionMatch?: boolean;
  /**
   * Show the model what a person sees that the accessible name leaves out
   * (visible text beside an aria-label, a placeholder, a logo, an icon's
   * kind). On unless set to false.
   */
  readonly nameHints?: boolean;
  /**
   * When the sentence refers to an item ("on the post about DNS") and code
   * cannot match it, ask the Resolver one yes/no question per same-name
   * member's item and act on a clear winner. Needs Resolver.verifyItems.
   * On unless set to false.
   */
  readonly verifyItems?: boolean;
  /**
   * Looser code rules for ordinals and item references (counts masked in
   * names, prepositions ignored), also applied when the model answers none.
   * On unless set to false.
   */
  readonly codeFallback?: boolean;
}

/** Counts do not tell members apart: "306 comments" and "12 comments". */
function maskedName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/\d[\d.,]*[km]?(?=\s+\p{L})/gu, "#");
}

function hintedCandidate(candidate: Candidate): Candidate {
  const hint = candidate.signals.nameHint;
  if (!hint) return candidate;
  const points = Array.from(`${candidate.name} (${hint})`);
  const name =
    points.length <= NAME_LIMIT
      ? points.join("")
      : points.slice(0, NAME_LIMIT - 1).join("") + "…";
  return { ...candidate, name };
}

export interface RepeatedMemberPolicy {
  /** Accept any member when every member links to the same address. */
  readonly sameDestination?: boolean;
  /**
   * Accept a pick among at most three links to one address whose names are
   * the same text, or one inside the other, such as a header and a footer
   * Pricing link, when the sentence names only that text.
   */
  readonly duplicateLinks?: boolean;
  /**
   * Act on the model's pick among repeated elements with no further gate:
   * no sentence evidence, no group or member confidence, no narrowing call.
   */
  readonly modelPick?: boolean;
  /** Accept the model's pick at or above this probability and lead. */
  readonly trust?: {
    readonly minProbability: number;
    readonly minLead: number;
  };
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
  if (collected.length !== first.total) throw new LocatorError("stale");
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

/**
 * After elimination rounds the finalists are a few batch winners, out of
 * order and without the same-name elements around them, so "the second Try
 * it" or "zoneinfo in See also" loses its meaning. Give the final round every
 * same-name or same-destination sibling of a finalist, in page order, when
 * that still fits one request.
 */
function withSiblings(
  sentence: string,
  finalists: readonly Candidate[],
  candidates: readonly Candidate[],
): Candidate[] {
  const keep = new Set<Candidate>(finalists);
  for (const finalist of finalists)
    for (const sibling of repeatedGroup(finalist, candidates))
      keep.add(sibling);
  const ordered = candidates.filter((candidate) => keep.has(candidate));
  try {
    return batches(sentence, ordered).length === 1 ? ordered : [...finalists];
  } catch {
    return [...finalists];
  }
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
    words(candidate.name).some((word) => sentenceWords.includes(word));
  if (
    /\b(first|top)(?:\s+ranked)?\s+story\b/i.test(sentence) &&
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
  const texts = (candidate: Candidate): string[] => [
    candidate.name,
    ...candidate.peers,
    ...(candidate.location?.split(/[,·]/) ?? []),
  ];
  const otherTexts = group
    .filter((candidate) => candidate !== selected)
    .flatMap((candidate) => texts(candidate).map(words));
  return texts(selected).some((text) => {
    const phrase = words(text);
    return (
      containsPhrase(sentenceWords, phrase) &&
      !otherTexts.some((other) => containsPhrase(other, phrase))
    );
  });
}

/** Why a repeated member without sentence evidence is still accepted, if it is. */
function repeatedMemberAccepted(
  policy: RepeatedMemberPolicy | undefined,
  sentence: string,
  member: Candidate,
  group: readonly Candidate[],
  decision: ResolverDecision,
): string | null {
  if (!policy) return null;
  if (policy.modelPick)
    // Act on the model's pick unless the sentence itself singles out a
    // different member ("in the article body" against a sidebar pick).
    return group.some(
      (other) => other !== member && sentenceEvidence(sentence, other, group),
    )
      ? null
      : "repeated_member_model_pick";
  const href = member.signals.href?.trim();
  if (
    policy.sameDestination &&
    href &&
    // "#" and script links run page code, so equal hrefs prove nothing.
    href !== "#" &&
    !/^javascript:/i.test(href) &&
    group.every((candidate) => candidate.signals.href?.trim() === href)
  )
    return "repeated_member_same_destination";
  if (
    policy.duplicateLinks &&
    href &&
    href !== "#" &&
    !/^javascript:/i.test(href) &&
    group.length <= 3 &&
    !qualifiesMember(sentence, member) &&
    group.every((candidate) => {
      const name = candidate.name.trim().toLocaleLowerCase();
      const picked = member.name.trim().toLocaleLowerCase();
      return (
        candidate.signals.href?.trim() === href &&
        (name.includes(picked) || picked.includes(name))
      );
    })
  )
    return "repeated_member_duplicate_link";
  if (
    policy.trust &&
    qualifiesMember(sentence, member) &&
    decision.probabilities[member.ref]! >= policy.trust.minProbability &&
    comparableLead(decision, member.ref) >= policy.trust.minLead
  )
    return "repeated_member_trusted";
  return null;
}

const FILLER_WORDS = new Set(
  (
    "a an the this that it its please then and or of on in into to at for " +
    "click tap press hit open select choose check tick uncheck toggle type " +
    "enter fill go button link icon field box option menu tab checkbox " +
    "radio switch item control"
  ).split(" "),
);

/**
 * Whether the sentence says something beyond the member's own label, such as
 * a row, an ordinal, or a region. "click Add to cart" does not, so a confident
 * model pick among six Add to cart buttons is still a guess.
 */
function qualifiesMember(sentence: string, member: Candidate): boolean {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const label = new Set(words(member.name));
  return words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).some(
    (word) => !label.has(word) && !FILLER_WORDS.has(word),
  );
}

const REGIONS: readonly {
  readonly sentence: RegExp;
  readonly location: (location: string) => boolean;
}[] = [
  {
    sentence:
      /\b(header|navbar|masthead|top (?:nav(?:igation)?|bar|menu)|(?:global|main) (?:nav(?:igation)?|menu))\b/i,
    location: (location) =>
      /\bheader\b/.test(location) ||
      (/\bnavigation\b/.test(location) &&
        !/\b(footer|sidebar)\b/.test(location)),
  },
  {
    sentence: /\b(footer|bottom of the page)\b/i,
    location: (location) => /\bfooter\b/.test(location),
  },
  {
    sentence:
      /\b(sidebar|side ?bar|side menu|left (?:menu|nav(?:igation)?)|table of contents)\b/i,
    location: (location) =>
      /\bsidebar\b/.test(location) ||
      (/\bnavigation\b/.test(location) &&
        !/\b(header|footer)\b/.test(location)),
  },
  {
    sentence: /\b(dialog|modal|pop-?up)\b/i,
    location: (location) => /\bdialog\b/.test(location),
  },
];

/**
 * Candidates in the page region the sentence names, such as "in the footer".
 * Returns every candidate when the sentence names none, or when no candidate
 * is known to be there, so a missing landmark never hides the target.
 */
function inNamedRegion(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate[] {
  const named = REGIONS.filter((region) => region.sentence.test(sentence));
  if (named.length !== 1) return [...candidates];
  // A control the sentence names outright stays even when the page does not
  // mark the region it sits in.
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const regionWords = new Set(
    words(sentence.match(named[0]!.sentence)?.[0] ?? ""),
  );
  const wanted = words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).filter(
    (word) => !FILLER_WORDS.has(word) && !regionWords.has(word),
  );
  const kept = candidates.filter((candidate) => {
    if (named[0]!.location(candidate.location ?? "")) return true;
    if (!wanted.length) return false;
    const name = new Set(words(candidate.name));
    return wanted.every((word) => name.has(word));
  });
  return kept.length ? kept : [...candidates];
}

const GRAMMAR_WORDS = new Set(
  "a an the this that it its please then and or of on in into to at for".split(
    " ",
  ),
);
const ROLE_WORDS = new Set(
  (
    "click tap press hit open select choose check tick uncheck toggle " +
    "button link icon field box option menu tab checkbox radio switch " +
    "item control slider dropdown"
  ).split(" "),
);

/**
 * "click the checkbox" names only a kind of control. When the page has
 * another control of the same role with a different name, no pick is safe.
 * Words that also appear in the chosen element's name count as naming it, so
 * "click Go" or "click Button" still resolve.
 */
function roleOnlyAmbiguous(
  sentence: string,
  selected: Candidate,
  candidates: readonly Candidate[],
): boolean {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const named = new Set(words(selected.name));
  const meaningful = words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).filter(
    (word) => !GRAMMAR_WORDS.has(word),
  );
  if (
    !meaningful.length ||
    meaningful.some((word) => !ROLE_WORDS.has(word) || named.has(word))
  )
    return false;
  const role = selected.role || selected.tag;
  return candidates.some(
    (candidate) =>
      candidate !== selected &&
      (candidate.role || candidate.tag) === role &&
      candidate.name.trim().toLocaleLowerCase() !==
        selected.name.trim().toLocaleLowerCase(),
  );
}

/**
 * Another offered element whose name also holds every meaningful word of the
 * sentence, and that the model gave real weight: "click Hide" against "Hide
 * Contents" and "Hide Appearance". The sentence does not tell them apart.
 */
function nearNamesake(
  sentence: string,
  selected: Candidate,
  offered: readonly Candidate[],
  decision: ResolverDecision,
): boolean {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const content = words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).filter(
    (word) => !FILLER_WORDS.has(word),
  );
  if (!content.length) return false;
  const holdsAll = (candidate: Candidate) => {
    const name = new Set(words(candidate.name));
    return content.every((word) => name.has(word));
  };
  if (!holdsAll(selected)) return false;
  return offered.some(
    (candidate) =>
      candidate !== selected &&
      candidate.name.trim().toLocaleLowerCase() !==
        selected.name.trim().toLocaleLowerCase() &&
      (decision.probabilities[candidate.ref] ?? 0) >= 0.05 &&
      holdsAll(candidate),
  );
}

const ORDINALS: Readonly<Record<string, number>> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  "1st": 1,
  "2nd": 2,
  "3rd": 3,
  "4th": 4,
  "5th": 5,
  last: -1,
};
const ITEM_NOUNS = new Set(
  (
    "story post result product item row card example question comment " +
    "entry listing article plan option message email file folder review " +
    "one button link icon checkbox tab field demo form"
  ).split(" "),
);
const MONEY = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\brs\.?\s?\d[\d,]*(?:\.\d+)?)/gi;

/**
 * Counting, prices, and "which row" are where the model is weakest, so they
 * are resolved in code among the model's pick and its same-name siblings, in
 * page order:
 * - "the second Add to cart", "the first story's comments": the k-th member;
 * - "Add to cart for the cheapest", "the most expensive": the member whose
 *   item holds the lowest or highest single price;
 * - "Edit for Grace Hopper", "the post about DNS": the one member whose item
 *   text holds every word of the reference.
 * Returns null unless exactly one member qualifies, so any doubt falls back
 * to the model and the confidence gate.
 */
function resolveInCode(
  sentence: string,
  pick: Candidate,
  candidates: readonly Candidate[],
  loose = false,
): Candidate | null {
  // Same visible name only, and within the region the sentence names.
  const key = (candidate: Candidate) =>
    loose
      ? maskedName(candidate.name)
      : candidate.name.trim().toLocaleLowerCase();
  const name = key(pick);
  let group = inNamedRegion(
    sentence,
    candidates.filter((candidate) => key(candidate) === name),
  );
  if (group.length < 2 || !group.includes(pick)) return null;
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const said = words(sentence.replace(/\{\{[^}]*\}\}/g, " "));
  const label = new Set(words(pick.name));
  const referenceAt = said.findIndex((word) =>
    /^(for|on|about|of|from|under|by)$/.test(word),
  );
  const ordinal = said.find((word, index) => {
    if (ORDINALS[word] === undefined || label.has(word)) return false;
    // Preserve literal item references such as "first released in 1993".
    // An ordinal before the reference still has to pass the whole-request
    // check, even when a later reference uniquely names an item.
    const next = said[index + 1] ?? "";
    return !(
      loose &&
      referenceAt >= 0 &&
      index > referenceAt &&
      !label.has(next) &&
      /^(released|published|created|updated|modified)$/.test(next)
    );
  });
  const lowest = /\b(cheapest|lowest[- ]priced?|least expensive)\b/i.test(
    sentence,
  );
  const highest = /\b(most expensive|highest[- ]priced?|priciest)\b/i.test(
    sentence,
  );
  if (ordinal || lowest || highest) {
    // Recognize whole, deliberately small request forms, not just an ordinal
    // or price word somewhere in a sentence. Unknown qualifiers belong to the
    // model/evidence path; they must never turn into a global comparison.
    let request = said.join(" ");
    const scope = /\s+(?:in|under|inside|within) (?:the )?(.+)$/.exec(request);
    if (scope) {
      const wanted = scope[1]!.replace(/ (?:section|region)$/, "");
      group = group.filter((member) =>
        /^article(?: body)?$/.test(wanted)
          ? member.signals.region === "article-body"
          : [member.signals.section, member.location].some((value) =>
              value
                ?.split("›")
                .some((part) => words(part).join(" ") === wanted),
            ),
      );
      if (!group.length) return null;
      request = request.slice(0, scope.index);
    }
    const control = words(loose ? maskedName(pick.name) : pick.name).join(" ");
    if (!control) return null;
    const relation =
      ordinal ??
      (lowest
        ? "(?:cheapest|lowest price(?:d)?|least expensive)"
        : "(?:most expensive|highest price(?:d)?|priciest)");
    const noun = `(?:${[...ITEM_NOUNS].join("|")})`;
    const target = `(?:the )?${control}(?: button| link)?`;
    const ranked = `(?:the )?${relation}`;
    const form = new RegExp(
      `^(?:(?:please )?(?:click|tap|press|open|select|choose) )?(?:` +
        `${ranked} ${target}|` +
        `${target} (?:for|on|of) ${ranked}(?: ${noun})?|` +
        `${target} ${ranked} ${noun}|` +
        `${ranked} ${noun}(?: s)? ${target})$`,
    );
    if (!form.test(request) || (lowest && highest)) return null;
    const kind = new RegExp(`${control} (button|link)(?: |$)`).exec(
      request,
    )?.[1];
    if (kind) {
      group = group.filter((member) => member.role === kind);
      if (!group.length) return null;
    }
  }
  const items = group.map((member) => member.signals.item ?? "");
  // Prices and references need every member's whole item to compare.
  const complete = group.every((member) => !!member.signals.item);
  // Pinned, sponsored, or promoted entries break "the first story".
  if (
    items.some((text) =>
      /\b(sponsored|promoted|pinned|advertisement)\b/i.test(text),
    )
  )
    return null;
  // Ordinals.
  if (ordinal) {
    const k = ORDINALS[ordinal]!;
    const index = k === -1 ? group.length - 1 : k - 1;
    return index < group.length ? group[index]! : null;
  }

  // Lowest or highest price.
  if ((lowest || highest) && !complete) return null;
  if (lowest || highest) {
    const prices = items.map((text) => {
      const found = new Set(
        (text.match(MONEY) ?? []).map((value) =>
          Number(value.replace(/[^\d.]/g, "")),
        ),
      );
      return found.size === 1 ? [...found][0]! : NaN;
    });
    if (prices.some((price) => Number.isNaN(price))) return null;
    const target = lowest ? Math.min(...prices) : Math.max(...prices);
    const at = prices.flatMap((price, index) =>
      price === target ? [index] : [],
    );
    return at.length === 1 ? group[at[0]!]! : null;
  }

  // A reference to the item: "for Grace Hopper", "on the post about DNS".
  const reference = /\b(?:for|on|about|of|from|under|by)\s+(.+)$/i.exec(
    sentence.replace(/\{\{[^}]*\}\}/g, " "),
  );
  // Loosely, members without item text (a sidebar copy) are left out, as
  // long as at least two members can be compared.
  if (
    !reference ||
    (!complete && !(loose && items.filter((text) => !!text).length >= 2))
  )
    return null;
  const phrase = reference[0].toLocaleLowerCase();
  // "Copy for LLM" is a label, not a reference.
  if (
    candidates.some((candidate) =>
      candidate.name.toLocaleLowerCase().includes(phrase),
    )
  )
    return null;
  const wanted = words(reference[1]!).filter(
    (word) =>
      word.length > 1 &&
      !FILLER_WORDS.has(word) &&
      !ITEM_NOUNS.has(word) &&
      !label.has(word) &&
      !(loose && REFERENCE_WORDS.has(word)),
  );
  if (!wanted.length) return null;
  const matching = group.filter((member, index) => {
    if (!items[index]) return false;
    const own = new Set(words(member.name));
    const text = new Set(words(items[index]!).filter((word) => !own.has(word)));
    return wanted.every((word) => text.has(word));
  });
  return matching.length === 1 ? matching[0]! : null;
}

/** "Go to comments" is named by "the comments". */
const NAVIGATION_VERBS = new Set("go view see show visit".split(" "));

/**
 * The one repeated control the sentence names outright, counts ignored:
 * "Share" in "click Share on the post about ...", "# Go to comments" in "open
 * the comments for ...". Every content word of its name is in the sentence,
 * and no other stated name is longer. Null unless exactly one such name has
 * at least two members.
 */
function statedGroupPick(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate | null {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const said = new Set(words(sentence.replace(/\{\{[^}]*\}\}/g, " ")));
  const content = (name: string) =>
    words(name.replace("#", " ")).filter(
      (word) => !FILLER_WORDS.has(word) && !NAVIGATION_VERBS.has(word),
    );
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = maskedName(candidate.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: { key: string; size: number; pick: Candidate }[] = [];
  for (const candidate of candidates) {
    if (candidate.signals.nameTruncated) continue;
    const key = maskedName(candidate.name);
    const own = content(key);
    if (!own.length || !own.every((word) => said.has(word))) continue;
    if ((counts.get(key) ?? 0) < 2) continue;
    if (best.length && own.length < best[0]!.size) continue;
    if (best.length && own.length > best[0]!.size) best = [];
    if (!best.some((entry) => entry.key === key))
      best.push({ key, size: own.length, pick: candidate });
  }
  return best.length === 1 ? best[0]!.pick : null;
}

/** Whether every content word of the element's name is in the sentence. */
function nameStated(sentence: string, candidate: Candidate): boolean {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const said = new Set(words(sentence));
  const own = words(maskedName(candidate.name).replace("#", " ")).filter(
    (word) => !FILLER_WORDS.has(word) && !NAVIGATION_VERBS.has(word),
  );
  return own.length > 0 && own.every((word) => said.has(word));
}

/**
 * After the model answers none, or picks an element the sentence does not
 * name: the stated repeated control, resolved by ordinal, price, or item
 * reference in code. Null unless exactly one member qualifies.
 */
function codeAfterNone(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate | null {
  const pick = statedGroupPick(sentence, candidates);
  return pick ? resolveInCode(sentence, pick, candidates, true) : null;
}

const REFERENCE_WORDS = new Set(
  "about from by under with in is was were that which whose where".split(" "),
);

const REFERENCE_PHRASE =
  /\b(?:on|for|about|of)\s+(?:the|a|an|this|that)\s+(.+)$/i;
const ORDINAL_OR_PRICE =
  /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d+(?:st|nd|rd|th)|cheapest|lowest|highest|most expensive|least expensive|priciest)\b/i;
const MAX_VERIFIED_ITEMS = 40;
const ITEM_TEXT_LIMIT = 300;

/**
 * Members of the pick's same-name group worth one yes/no question each, when
 * the sentence refers to an item and code could not match it.
 */
function itemQuestionGroup(
  sentence: string,
  pick: Candidate,
  candidates: readonly Candidate[],
): Candidate[] | null {
  const text = sentence.replace(/\{\{[^}]*\}\}/g, " ");
  const reference = REFERENCE_PHRASE.exec(text);
  if (!reference || ORDINAL_OR_PRICE.test(reference[1]!)) return null;
  const phrase = reference[0].toLocaleLowerCase();
  if (
    candidates.some((candidate) =>
      candidate.name.toLocaleLowerCase().includes(phrase),
    )
  )
    return null;
  const name = maskedName(pick.name);
  const group = inNamedRegion(
    sentence,
    candidates.filter((candidate) => maskedName(candidate.name) === name),
  );
  if (!group.includes(pick) || !pick.signals.item) return null;
  const members = group.filter((member) => !!member.signals.item?.trim());
  if (members.length < 2 || members.length > MAX_VERIFIED_ITEMS) return null;
  return members;
}

const SECTION_NOUNS = new Set(
  (
    "sidebar side section box demo panel area region list banner header " +
    "footer navigation nav menu bar top bottom left right under inside " +
    "within below beneath above near page example card block widget part " +
    "container group dropdown select field input textbox"
  ).split(" "),
);

/**
 * "open Python for Everybody under Most popular", "click Attributes in the
 * In this article sidebar": among the pick's same-name members (within the
 * region the sentence names), the one whose section labels hold every word
 * the sentence adds beyond the label. Null unless exactly one qualifies.
 */
function resolveBySection(
  sentence: string,
  pick: Candidate,
  candidates: readonly Candidate[],
): Candidate | null {
  const text = sentence.replace(/\{\{[^}]*\}\}/g, " ");
  if (!/\b(in|under|inside|within|from|below|beneath|of)\b/i.test(text))
    return null;
  const stem = (word: string) =>
    word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
  const words = (value: string): string[] =>
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
  const name = pick.name.trim().toLocaleLowerCase();
  const group = inNamedRegion(
    sentence,
    candidates.filter(
      (candidate) => candidate.name.trim().toLocaleLowerCase() === name,
    ),
  );
  if (group.length < 2 || !group.includes(pick)) return null;
  const label = new Set(words(pick.name));
  const filler = new Set([...FILLER_WORDS, ...SECTION_NOUNS].map(stem));
  const wanted = [
    ...new Set(
      words(text).filter((word) => !label.has(word) && !filler.has(word)),
    ),
  ];
  if (!wanted.length) return null;
  const matching = group.filter((member) => {
    const section = new Set(words(member.signals.section ?? ""));
    return wanted.every((word) => section.has(word));
  });
  return matching.length === 1 ? matching[0]! : null;
}

/**
 * The pick's name shares no meaningful word with the sentence, while another
 * offered element's name holds all of them: "click Sign In" picking a promo
 * link over the Sign In link.
 */
function lexicalMiss(
  sentence: string,
  selected: Candidate,
  offered: readonly Candidate[],
): boolean {
  const words = (text: string): string[] =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const content = words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).filter(
    (word) => !FILLER_WORDS.has(word),
  );
  if (!content.length) return false;
  const picked = new Set(words(selected.name));
  if (content.some((word) => picked.has(word))) return false;
  return offered.some((candidate) => {
    if (candidate === selected) return false;
    const name = new Set(words(candidate.name));
    return content.every((word) => name.has(word));
  });
}

function sameIdentity(a: Candidate, b: Candidate): boolean {
  if (
    a.signals.nodeId !== b.signals.nodeId ||
    a.tag !== b.tag ||
    a.role !== b.role ||
    a.name !== b.name ||
    a.inputType !== b.inputType ||
    a.editable !== b.editable ||
    a.disabled !== b.disabled ||
    a.signals.rawName !== b.signals.rawName ||
    a.signals.nameTruncated !== b.signals.nameTruncated ||
    a.signals.region !== b.signals.region ||
    a.signals.path !== b.signals.path ||
    a.signals.item !== b.signals.item ||
    a.signals.section !== b.signals.section ||
    JSON.stringify(a.peers) !== JSON.stringify(b.peers) ||
    a.location !== b.location
  )
    return false;
  for (const key of ["hook", "id", "name", "href"] as const) {
    if (a.signals[key] !== b.signals[key]) return false;
  }
  return true;
}

function sameChoiceSurface(
  original: readonly Candidate[],
  fresh: readonly Candidate[],
): boolean {
  return (
    original.length === fresh.length &&
    original.every((candidate, index) => {
      const next = fresh[index];
      return next && sameIdentity(candidate, next);
    })
  );
}

function exactNameRequested(sentence: string, candidate: Candidate): boolean {
  if (candidate.signals.nameTruncated) return false;
  const words = (text: string) =>
    text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const name = words(candidate.name);
  const request = words(sentence);
  return (
    name.length > 0 &&
    request.some((_, index) =>
      name.every((word, offset) => request[index + offset] === word),
    )
  );
}

function sameNodeControl(a: Candidate, b: Candidate): boolean {
  return (
    !!a.signals.nodeId &&
    a.signals.nodeId === b.signals.nodeId &&
    a.tag === b.tag &&
    a.role === b.role &&
    a.name === b.name &&
    a.inputType === b.inputType &&
    a.editable === b.editable &&
    a.disabled === b.disabled &&
    a.signals.rawName === b.signals.rawName &&
    a.signals.nameTruncated === b.signals.nameTruncated &&
    a.signals.region === b.signals.region &&
    a.signals.path === b.signals.path &&
    a.signals.hook === b.signals.hook &&
    a.signals.id === b.signals.id &&
    a.signals.name === b.signals.name &&
    a.signals.href === b.signals.href
  );
}

function provedTargetChange(
  old: CacheEntry,
  selected: Candidate,
  candidates: readonly Candidate[],
  key: Uint8Array,
): boolean {
  const oldHook = old.digests.hook;
  const oldId = old.digests.id;
  if (
    !oldHook ||
    !oldId ||
    !selected.signals.hook ||
    !selected.signals.id ||
    oldHook === keyedDigest(key, selected.signals.hook) ||
    oldId === keyedDigest(key, selected.signals.id)
  )
    return false;
  return candidates.some(
    (candidate) =>
      candidate.ref !== selected.ref &&
      !!candidate.signals.hook &&
      !!candidate.signals.id &&
      keyedDigest(key, candidate.signals.hook) === oldHook &&
      keyedDigest(key, candidate.signals.id) === oldId,
  );
}

/** Resolve a sentence to one fresh page target. No browser action occurs here. */
export async function resolveTarget(
  page: BrowserPage,
  resolver: Resolver,
  options: LocatorOptions,
): Promise<LocatorResult> {
  const calls: ProviderCall[] = [];
  const repeatedMember = options.repeatedMember ?? { modelPick: true };
  const nameHints = options.nameHints !== false;
  const verifyItems = options.verifyItems !== false;
  const codeFallback = options.codeFallback !== false;
  let candidateCount = 0;
  let rounds = 0;
  let top: LocatorOptionDiagnostic[] = [];
  let confidence: number | null = null;
  let observationVersion: PageVersion | undefined;
  let gate: string | undefined;
  let cacheOutcome: LocatorCacheDiagnostic | undefined;
  let storedEntry: CacheEntry | undefined;
  const cacheSentence = options.cacheSentence ?? options.sentence;
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
    ...(cacheOutcome
      ? { cache: { ...cacheOutcome, fallbackCalledModel: calls.length > 0 } }
      : {}),
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
    if (options.operation === "fill" && source.candidates.length === 0) {
      // Hydrating forms can render a visible input before attaching its label.
      // Wait briefly for a named fill target before asking the model to choose
      // among click controls. No target or action is reused during this read.
      const deadline = performance.now() + 1_500;
      while (source.candidates.length === 0 && performance.now() < deadline) {
        ensureActive();
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        source = await fullSet(page, "fill");
      }
      if (source.candidates.length === 0) source = await fullSet(page, "click");
    }
    observationVersion = source.version;
    ensureActive();
    if (options.cache) {
      const store = options.cache;
      if (!store.key) {
        const bypass = await store
          .lookup("")
          .catch(() => ({ reason: "storage_error" as const }));
        cacheOutcome = {
          outcome:
            "reason" in bypass &&
            (bypass.reason === "storage_error" || bypass.reason === "corrupt")
              ? "miss"
              : "bypassed",
          reason: "reason" in bypass ? bypass.reason : "disabled",
          fallbackCalledModel: false,
          targetChanged: false,
        };
      } else if (options.runtimeDependent) {
        cacheOutcome = {
          outcome: "bypassed",
          reason: "runtime_dependent",
          fallbackCalledModel: false,
          targetChanged: false,
        };
      } else {
        const digest = pageKey(
          store.key,
          source.version.route,
          options.operation,
          cacheSentence,
        );
        const lookup = await store
          .lookup(digest)
          .catch(() => ({ reason: "storage_error" as const }));
        storedEntry = "entry" in lookup ? lookup.entry : undefined;
        const matched =
          "reason" in lookup
            ? { hit: false as const, reason: lookup.reason }
            : matchEntry(
                storedEntry,
                store.key,
                source.version.route,
                options.operation,
                cacheSentence,
                source.candidates,
                true,
                options.runtimeDependent,
              );
        if (matched.hit) {
          if (!sameVersion(await pageVersion(page), source.version)) {
            cacheOutcome = {
              outcome: "miss",
              reason: "candidate_set_incomplete",
              fallbackCalledModel: false,
              targetChanged: false,
            };
            return unresolved("stale");
          }
          return {
            kind: "resolved",
            target: new ResolvedStepTarget({
              ref: matched.candidate.ref,
              version: source.version,
              tag: matched.candidate.tag,
              name: matched.candidate.name,
            }),
            diagnostic: {
              candidateCount: source.candidates.length,
              rounds: 0,
              confidence: null,
              observationVersion: source.version,
              topOptions: [],
            },
            calls,
            cache: {
              outcome: "hit",
              reason: null,
              fallbackCalledModel: false,
              targetChanged: false,
            },
          };
        }
        cacheOutcome = {
          outcome: "miss",
          reason: matched.reason,
          fallbackCalledModel: false,
          targetChanged: false,
        };
        if (
          matched.reason !== "absent" &&
          matched.reason !== "storage_error" &&
          matched.reason !== "candidate_set_incomplete"
        )
          await store.invalidate(digest, storedEntry).catch(() => undefined);
      }
    }
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
              ...projectCandidates(
                requestOptions(nameHints ? pool.map(hintedCandidate) : pool),
              ).map((candidate) => ({
                kind: "candidate" as const,
                candidate: options.projectText
                  ? {
                      ...candidate,
                      name: options.projectText(candidate.name),
                      peers: candidate.peers.map(options.projectText),
                      ...(candidate.location
                        ? { location: options.projectText(candidate.location) }
                        : {}),
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
    // Filter by named region only when the page needs elimination rounds:
    // on a page that fits one request the model sees every location, and a
    // region the page does not mark would otherwise hide the target.
    let pool: Candidate[] =
      candidates.length > CANDIDATE_LIMIT
        ? inNamedRegion(options.sentence, candidates)
        : [...candidates];
    let finalists: Candidate[] = [];
    let decision: ResolverDecision;
    let reducedAcrossBatches = false;
    while (true) {
      const heats = batches(options.sentence, pool);
      if (heats.length === 1) {
        finalists = reducedAcrossBatches
          ? withSiblings(options.sentence, heats[0]!, candidates)
          : heats[0]!;
        decision = await choose(finalists);
        break;
      }
      reducedAcrossBatches = true;
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
    if (
      reducedAcrossBatches &&
      !sameVersion(await pageVersion(page), source.version)
    )
      return unresolved("stale");
    top = topOptions(decision, finalists);
    confidence = decision.confidence;
    if (decision.selection.kind === "none") {
      // Counting and item references are code's job even when the model
      // found nothing: "click View Product on the third product".
      const fallback = codeFallback
        ? codeAfterNone(options.sentence, candidates)
        : null;
      if (!fallback) return unresolved("none");
      gate = "resolved_in_code_after_none";
      if (options.operation === "fill" && !fallback.editable)
        return unresolved("not_fillable");
      return await refresh(fallback);
    }
    const selected = byId.get(decision.selection.id);
    if (!selected) return unresolved("provider_error");
    // The pick may be the item's title while the sentence names a control
    // on it ("click Share on the post about ..."): anchor on the named one.
    const anchor =
      codeFallback && !nameStated(options.sentence, selected)
        ? (statedGroupPick(options.sentence, candidates) ?? selected)
        : selected;
    const inCode =
      resolveInCode(options.sentence, selected, candidates) ??
      (codeFallback
        ? resolveInCode(options.sentence, anchor, candidates, true)
        : null);
    const bySection =
      options.sectionMatch !== false && !inCode
        ? resolveBySection(options.sentence, selected, candidates)
        : null;
    const coded = bySection ?? inCode;
    if (coded) {
      gate = bySection ? "resolved_by_section" : "resolved_in_code";
      if (options.operation === "fill" && !coded.editable)
        return unresolved("not_fillable");
      return await refresh(coded);
    }
    const itemMembers =
      verifyItems && resolver.verifyItems
        ? itemQuestionGroup(
            options.sentence,
            nameStated(options.sentence, selected)
              ? selected
              : (statedGroupPick(options.sentence, candidates) ?? selected),
            candidates,
          )
        : null;
    if (itemMembers) {
      const verified = await verifyByItems(itemMembers);
      if (verified) {
        gate = "resolved_by_items";
        if (options.operation === "fill" && !verified.editable)
          return unresolved("not_fillable");
        return await refresh(verified);
      }
    }
    const group = repeatedGroup(selected, candidates);
    const low =
      (decision.confidence !== null && decision.confidence < MIN_CONFIDENCE) ||
      comparableLead(decision, selected.ref) < MIN_LEAD;
    if (low && group.length >= 2 && repeatedMember.modelPick)
      gate = "repeated_member_model_pick";
    else if (low && group.length < 2 && options.acceptLowConfidence)
      gate = "low_confidence_accepted";
    else if (low) {
      gate = "low_confidence_or_margin";
      if (group.length < 2) return unresolved("ambiguous");
      const groupProbability = group.reduce(
        (sum, candidate) => sum + (decision.probabilities[candidate.ref] ?? 0),
        0,
      );
      if (groupProbability < 0.75) {
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
        const accepted = repeatedMemberAccepted(
          repeatedMember,
          options.sentence,
          member,
          group,
          narrower,
        );
        if (!accepted) {
          gate = "repeated_member_no_evidence";
          return unresolved("ambiguous");
        }
        gate = accepted;
      }
      if (gate === "low_confidence_or_margin") gate = "repeated_member_proven";
      if (options.operation === "fill" && !member.editable)
        return unresolved("not_fillable");
      if (roleOnlyAmbiguous(options.sentence, member, candidates)) {
        gate = "role_only_ambiguous";
        return unresolved("ambiguous");
      }
      return await refresh(member);
    }
    // Links that only share the pick's address ("Fork 6.5k" beside a star
    // link to the same login page) are told apart by their names already.
    // Counts do not tell members apart: "306 comments" and "12 comments"
    // are the same control on two stories.
    const masked = (name: string) =>
      name
        .trim()
        .toLocaleLowerCase()
        .replace(/\d[\d.,]*[km]?(?=\s+\p{L})/gu, "#");
    const sameName = candidates.filter(
      (candidate) => masked(candidate.name) === masked(selected.name),
    );
    if (
      sameName.length > 1 &&
      !sentenceEvidence(options.sentence, selected, sameName)
    ) {
      const accepted = repeatedMemberAccepted(
        repeatedMember,
        options.sentence,
        selected,
        sameName,
        decision,
      );
      if (!accepted) {
        gate = "repeated_member_no_evidence";
        return unresolved("ambiguous");
      }
      gate = accepted;
    }
    if (options.operation === "fill" && !selected.editable)
      return unresolved("not_fillable");
    if (roleOnlyAmbiguous(options.sentence, selected, candidates)) {
      gate = "role_only_ambiguous";
      return unresolved("ambiguous");
    }
    if (
      group.length < 2 &&
      nearNamesake(options.sentence, selected, finalists, decision)
    ) {
      gate = "near_namesake";
      return unresolved("ambiguous");
    }
    if (lexicalMiss(options.sentence, selected, finalists)) {
      gate = "lexical_miss";
      return unresolved("ambiguous");
    }
    return await refresh(selected);

    /** One yes/no question per member's item; a clear winner or null. */
    async function verifyByItems(
      members: readonly Candidate[],
    ): Promise<Candidate | null> {
      ensureActive();
      const project = options.projectText ?? ((text: string) => text);
      let verdict: ItemVerdict;
      try {
        verdict = await resolver.verifyItems!(
          options.sentence,
          members.map((member) => ({
            id: member.ref,
            text: project(
              Array.from(member.signals.item!.replace(/\s+/g, " ").trim())
                .slice(0, ITEM_TEXT_LIMIT)
                .join(""),
            ),
          })),
          { signal: controller.signal },
        );
      } catch (error) {
        calls.push(unknownCostCall(error));
        ensureActive();
        return null;
      }
      calls.push(verdict.call);
      ensureActive();
      const ranked = members
        .map((member) => ({
          member,
          score: verdict.scores[member.ref],
        }))
        .filter(
          (entry): entry is { member: Candidate; score: number } =>
            typeof entry.score === "number" &&
            Number.isFinite(entry.score) &&
            entry.score >= 0 &&
            entry.score <= 1,
        )
        .sort((a, b) => b.score - a.score);
      if (ranked.length !== members.length) return null;
      const [best, second] = ranked;
      if (!best || best.score < 0.6 || best.score - (second?.score ?? 0) < 0.2)
        return null;
      if (!sameVersion(await pageVersion(page), source.version)) return null;
      return best.member;
    }

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
      const surfaceStable = sameChoiceSurface(
        source.candidates,
        fresh.candidates,
      );
      let matches = fresh.candidates.filter((candidate) =>
        sameIdentity(selectedCandidate, candidate),
      );
      if (!surfaceStable) {
        const uniqueBefore =
          source.candidates.filter(
            (candidate) =>
              candidate.name === selectedCandidate.name &&
              candidate.role === selectedCandidate.role,
          ).length === 1;
        const uniqueAfter =
          fresh.candidates.filter(
            (candidate) =>
              candidate.name === selectedCandidate.name &&
              candidate.role === selectedCandidate.role,
          ).length === 1;
        if (
          !uniqueBefore ||
          !uniqueAfter ||
          !exactNameRequested(options.sentence, selectedCandidate)
        )
          return unresolved("stale");
        matches = fresh.candidates.filter((candidate) =>
          sameNodeControl(selectedCandidate, candidate),
        );
      }
      if (matches.length !== 1) return unresolved("stale");
      ensureActive();
      if (
        cacheOutcome?.outcome === "miss" &&
        storedEntry &&
        options.cache?.key &&
        provedTargetChange(
          storedEntry,
          matches[0]!,
          fresh.candidates,
          options.cache.key,
        )
      )
        cacheOutcome = { ...cacheOutcome, targetChanged: true };
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
        ...(cacheOutcome
          ? {
              cache: { ...cacheOutcome, fallbackCalledModel: calls.length > 0 },
            }
          : {}),
        ...(options.cache?.key &&
        !options.runtimeDependent &&
        cacheOutcome?.outcome === "miss"
          ? {
              cacheSeed: {
                candidate: matches[0]!,
                eligible: fresh,
                key: pageKey(
                  options.cache.key,
                  fresh.version.route,
                  options.operation,
                  cacheSentence,
                ),
              },
            }
          : {}),
      };
    }
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
    if (error instanceof LocatorError) return unresolved(error.reason);
    if (error instanceof PageScriptError) return unresolved("incomplete");
    return unresolved("provider_error");
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
