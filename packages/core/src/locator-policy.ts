import { LocatorError } from "./locator-error.js";
import type { Candidate } from "./page-protocol.js";
import type { ResolverDecision } from "./provider.js";
import type {
  LocatorOptionDiagnostic,
  RepeatedMemberPolicy,
} from "./locator.js";

const FILLER_WORDS = new Set(
  (
    "a an the this that it its please then and or of on in into to at for " +
    "click tap press hit open select choose check tick uncheck toggle type " +
    "enter fill go button link icon field box option menu tab checkbox " +
    "radio switch item control"
  ).split(" "),
);
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
const words = (text: string): string[] =>
  text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const normalizedName = (candidate: Candidate): string =>
  candidate.name.trim().toLocaleLowerCase();

function sameName(a: Candidate, b: Candidate): boolean {
  return normalizedName(a) === normalizedName(b);
}

function unboundWords(
  sentence: string,
  ignored: ReadonlySet<string>,
): string[] {
  return words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).filter(
    (word) => !ignored.has(word),
  );
}

export function validateDecision(
  decision: ResolverDecision,
  candidates: readonly Candidate[],
): void {
  const expected = new Set([...candidates.map(({ ref }) => ref), "none"]);
  const probabilities = decision.probabilities;
  const actual = Object.keys(probabilities);
  const values = Object.values(probabilities);
  const invalidKeys = !sameKeys(actual, expected);
  const invalidValues = values.some(invalidProbability);
  const invalidTotal =
    Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02;
  const confidence = decision.confidence;
  const invalidConfidence =
    confidence !== null &&
    (!Number.isFinite(confidence) || confidence < 0 || confidence > 1);
  const selected =
    decision.selection.kind === "none" ? "none" : decision.selection.id;
  const invalidSelection =
    !expected.has(selected) ||
    probabilities[selected]! + 1e-9 < Math.max(...values);
  if (
    [
      invalidKeys,
      invalidValues,
      invalidTotal,
      invalidConfidence,
      invalidSelection,
    ].some(Boolean)
  )
    throw new LocatorError("provider_error");
}

function sameKeys(
  actual: readonly string[],
  expected: ReadonlySet<string>,
): boolean {
  return (
    actual.length === expected.size && actual.every((id) => expected.has(id))
  );
}

function invalidProbability(value: number): boolean {
  return !Number.isFinite(value) || value < 0 || value > 1;
}

export function topOptions(
  decision: ResolverDecision,
  candidates: readonly Candidate[],
  excerpt: (value: string, limit: number) => string,
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

export function comparableLead(decision: ResolverDecision, id: string): number {
  const others = Object.entries(decision.probabilities)
    .filter(([other]) => other !== id)
    .map(([, probability]) => probability);
  return decision.probabilities[id]! - Math.max(0, ...others);
}

export function repeatedGroup(
  selected: Candidate,
  candidates: readonly Candidate[],
): Candidate[] {
  const name = normalizedName(selected);
  return candidates.filter(
    (candidate) =>
      normalizedName(candidate) === name ||
      (!!selected.signals.href &&
        candidate.signals.href === selected.signals.href),
  );
}

function containsPhrase(
  haystack: readonly string[],
  phrase: readonly string[],
): boolean {
  return (
    phrase.length > 0 &&
    haystack.some((_, index) =>
      phrase.every((word, offset) => haystack[index + offset] === word),
    )
  );
}

function uniquelyFirstStory(
  sentence: string,
  selected: Candidate,
  group: readonly Candidate[],
): boolean {
  const sentenceWords = words(sentence);
  const qualifies = (candidate: Candidate) =>
    candidate.peers.some((peer) => /^1[.)]\s/.test(peer)) &&
    words(candidate.name).some((word) => sentenceWords.includes(word));
  return (
    /\b(first|top)(?:\s+ranked)?\s+story\b/i.test(sentence) &&
    qualifies(selected) &&
    group.filter(qualifies).length === 1
  );
}

export function sentenceEvidence(
  sentence: string,
  selected: Candidate,
  group: readonly Candidate[],
): boolean {
  const sentenceWords = words(sentence);
  const uniqueArticleBody =
    selected.signals.region === "article-body" &&
    group.filter(({ signals }) => signals.region === "article-body").length ===
      1;
  if (/\barticle body\b/i.test(sentence) && uniqueArticleBody) return true;
  if (uniquelyFirstStory(sentence, selected, group)) return true;
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

function qualifiesMember(sentence: string, member: Candidate): boolean {
  const label = new Set(words(member.name));
  return words(sentence.replace(/\{\{[^}]*\}\}/g, " ")).some(
    (word) => !label.has(word) && !FILLER_WORDS.has(word),
  );
}

export interface RepeatedMemberContext {
  readonly policy: RepeatedMemberPolicy | undefined;
  readonly sentence: string;
  readonly member: Candidate;
  readonly group: readonly Candidate[];
  readonly decision: ResolverDecision;
}

function safeHref(candidate: Candidate): string | undefined {
  const href = candidate.signals.href?.trim();
  return href && href !== "#" && !/^javascript:/i.test(href) ? href : undefined;
}

function duplicateLink(context: RepeatedMemberContext, href: string): boolean {
  const { sentence, member, group } = context;
  const picked = normalizedName(member);
  return (
    group.length <= 3 &&
    !qualifiesMember(sentence, member) &&
    group.every((candidate) => {
      const name = normalizedName(candidate);
      return (
        candidate.signals.href?.trim() === href &&
        (name.includes(picked) || picked.includes(name))
      );
    })
  );
}

function modelPickAccepted(context: RepeatedMemberContext): string | null {
  const { sentence, member, group } = context;
  const contradicted = group.some(
    (other) => other !== member && sentenceEvidence(sentence, other, group),
  );
  return contradicted ? null : "repeated_member_model_pick";
}

function sameDestination(
  context: RepeatedMemberContext,
  href: string | undefined,
): boolean {
  return (
    !!href &&
    context.group.every((candidate) => candidate.signals.href?.trim() === href)
  );
}

function trusted(context: RepeatedMemberContext): boolean {
  const { policy, sentence, member, decision } = context;
  if (!policy?.trust || !qualifiesMember(sentence, member)) return false;
  return [
    decision.probabilities[member.ref]! >= policy.trust.minProbability,
    comparableLead(decision, member.ref) >= policy.trust.minLead,
  ].every(Boolean);
}

function duplicateAccepted(
  context: RepeatedMemberContext,
  href: string | undefined,
): boolean {
  return !!href && duplicateLink(context, href);
}

export function repeatedMemberAccepted(
  context: RepeatedMemberContext,
): string | null {
  const { policy, member } = context;
  if (!policy) return null;
  if (policy.modelPick) return modelPickAccepted(context);
  const href = safeHref(member);
  if (policy.sameDestination && sameDestination(context, href))
    return "repeated_member_same_destination";
  if (policy.duplicateLinks && duplicateAccepted(context, href))
    return "repeated_member_duplicate_link";
  return trusted(context) ? "repeated_member_trusted" : null;
}

export function roleOnlyAmbiguous(
  sentence: string,
  selected: Candidate,
  candidates: readonly Candidate[],
): boolean {
  const named = new Set(words(selected.name));
  const meaningful = unboundWords(sentence, GRAMMAR_WORDS);
  const onlyRole =
    meaningful.length > 0 &&
    meaningful.every((word) => ROLE_WORDS.has(word) && !named.has(word));
  if (!onlyRole) return false;
  const role = selected.role || selected.tag;
  return candidates.some(
    (candidate) =>
      candidate !== selected &&
      (candidate.role || candidate.tag) === role &&
      !sameName(candidate, selected),
  );
}

export function nearNamesake(
  sentence: string,
  selected: Candidate,
  offered: readonly Candidate[],
  decision: ResolverDecision,
): boolean {
  const content = unboundWords(sentence, FILLER_WORDS);
  const holdsAll = (candidate: Candidate) => {
    const name = new Set(words(candidate.name));
    return content.every((word) => name.has(word));
  };
  if (!content.length || !holdsAll(selected)) return false;
  return offered.some(
    (candidate) =>
      candidate !== selected &&
      !sameName(candidate, selected) &&
      (decision.probabilities[candidate.ref] ?? 0) >= 0.05 &&
      holdsAll(candidate),
  );
}
