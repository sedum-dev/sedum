import type { Candidate } from "../page-protocol.js";

const FILLER_WORDS = new Set(
  (
    "a an the this that it its please then and or of on in into to at for " +
    "click tap press hit open select choose check tick uncheck toggle type " +
    "enter fill go button link icon field box option menu tab checkbox " +
    "radio switch item control"
  ).split(" "),
);

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
const REFERENCE_WORDS = new Set(
  "about from by under with in is was were that which whose where".split(" "),
);
const MONEY = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\brs\.?\s?\d[\d,]*(?:\.\d+)?)/gi;
const NAVIGATION_VERBS = new Set("go view see show visit".split(" "));
const REFERENCE_PHRASE =
  /\b(?:on|for|about|of)\s+(?:the|a|an|this|that)\s+(.+)$/i;
const ORDINAL_OR_PRICE =
  /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|\d+(?:st|nd|rd|th)|cheapest|lowest|highest|most expensive|least expensive|priciest)\b/i;
const MAX_VERIFIED_ITEMS = 40;
const SECTION_NOUNS = new Set(
  (
    "sidebar side section box demo panel area region list banner header " +
    "footer navigation nav menu bar top bottom left right under inside " +
    "within below beneath above near page example card block widget part " +
    "container group dropdown select field input textbox"
  ).split(" "),
);

/** Immutable text with the lexical transformations used by locator matching. */
class LexicalText {
  constructor(readonly value: string) {}

  words(): string[] {
    return this.value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  }

  withoutTemplates(): LexicalText {
    return new LexicalText(this.value.replace(/\{\{[^}]*\}\}/g, " "));
  }

  normalized(): string {
    return this.value.trim().toLocaleLowerCase();
  }

  maskedName(): string {
    return this.normalized().replace(/\d[\d.,]*[km]?(?=\s+\p{L})/gu, "#");
  }

  stemmedWords(): string[] {
    return this.words().map((word) =>
      word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word,
    );
  }
}

const candidateName = (candidate: Candidate, loose: boolean): string =>
  loose
    ? maskedName(candidate.name)
    : new LexicalText(candidate.name).normalized();

const hasSingleMatch = <T>(values: readonly T[]): values is readonly [T] =>
  values.length === 1;

/** Counts do not tell members apart: "306 comments" and "12 comments". */
export function maskedName(name: string): string {
  return new LexicalText(name).maskedName();
}

type Region = {
  readonly sentence: RegExp;
  readonly location: (location: string) => boolean;
};

const REGIONS: readonly Region[] = [
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

export function inNamedRegion(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate[] {
  const named = REGIONS.filter((region) => region.sentence.test(sentence));
  if (named.length !== 1) return [...candidates];
  const regionWords = new Set(
    new LexicalText(sentence.match(named[0]!.sentence)?.[0] ?? "").words(),
  );
  const wanted = new LexicalText(sentence)
    .withoutTemplates()
    .words()
    .filter((word) => !FILLER_WORDS.has(word) && !regionWords.has(word));
  const kept = candidates.filter((candidate) => {
    if (named[0]!.location(candidate.location ?? "")) return true;
    if (!wanted.length) return false;
    const name = new Set(new LexicalText(candidate.name).words());
    return wanted.every((word) => name.has(word));
  });
  return kept.length ? kept : [...candidates];
}

interface RankedRequest {
  readonly ordinal: string | undefined;
  readonly lowest: boolean;
  readonly highest: boolean;
  readonly request: LexicalText;
}

interface ResolutionContext {
  readonly sentence: LexicalText;
  readonly pick: Candidate;
  readonly candidates: readonly Candidate[];
  readonly loose: boolean;
}

interface GroupContext extends ResolutionContext {
  readonly group: readonly Candidate[];
  readonly items: readonly string[];
}

interface RankedGroupContext {
  readonly ranked: RankedRequest;
  readonly pick: Candidate;
  readonly group: readonly Candidate[];
  readonly loose: boolean;
}

function parseOrdinalPriceRequest(
  sentence: string,
  pick: Candidate,
  loose: boolean,
  referenceAt: number,
): RankedRequest {
  const said = new LexicalText(sentence).withoutTemplates().words();
  const label = new Set(new LexicalText(pick.name).words());
  const ordinal = said.find((word, index) => {
    if (ORDINALS[word] === undefined || label.has(word)) return false;
    const next = said[index + 1] ?? "";
    return !(
      loose &&
      referenceAt >= 0 &&
      index > referenceAt &&
      !label.has(next) &&
      /^(released|published|created|updated|modified)$/.test(next)
    );
  });
  return {
    ordinal,
    lowest: /\b(cheapest|lowest[- ]priced?|least expensive)\b/i.test(sentence),
    highest: /\b(most expensive|highest[- ]priced?|priciest)\b/i.test(sentence),
    request: new LexicalText(said.join(" ")),
  };
}

function filterScopedGroup(
  request: LexicalText,
  group: readonly Candidate[],
): { request: LexicalText; group: Candidate[] } | null {
  const scope = /\s+(?:in|under|inside|within) (?:the )?(.+)$/.exec(
    request.value,
  );
  if (!scope) return { request, group: [...group] };
  const wanted = scope[1]!.replace(/ (?:section|region)$/, "");
  const filtered = group.filter((member) =>
    /^article(?: body)?$/.test(wanted)
      ? member.signals.region === "article-body"
      : [member.signals.section, member.location].some((value) =>
          value
            ?.split("›")
            .some((part) => new LexicalText(part).words().join(" ") === wanted),
        ),
  );
  return filtered.length
    ? {
        request: new LexicalText(request.value.slice(0, scope.index)),
        group: filtered,
      }
    : null;
}

function rankedRequestGroup(
  ranked: RankedRequest,
  pick: Candidate,
  group: readonly Candidate[],
  loose: boolean,
): { request: RankedRequest; group: Candidate[] } | null {
  return parseRankedGroup({ ranked, pick, group, loose });
}

function parseRankedGroup(
  context: RankedGroupContext,
): { request: RankedRequest; group: Candidate[] } | null {
  const { ranked, pick, group, loose } = context;
  if (!hasRanking(ranked)) return { request: ranked, group: [...group] };
  const scoped = filterScopedGroup(ranked.request, group);
  if (!scoped) return null;
  const control = rankedControl(pick, loose);
  if (!control.value) return null;
  const form = rankedForm(ranked, control);
  if (!isValidRankedForm(form, scoped.request, ranked)) return null;
  const filtered = rankedRoleGroup(scoped.group, scoped.request, control);
  if (!filtered.length) return null;
  return { request: { ...ranked, request: scoped.request }, group: filtered };
}

function hasRanking(ranked: RankedRequest): boolean {
  return !!ranked.ordinal || ranked.lowest || ranked.highest;
}

function rankedControl(pick: Candidate, loose: boolean): LexicalText {
  const name = loose ? maskedName(pick.name) : pick.name;
  return new LexicalText(new LexicalText(name).words().join(" "));
}

function rankedForm(ranked: RankedRequest, control: LexicalText): RegExp {
  const relation = rankingPattern(ranked);
  const noun = `(?:${[...ITEM_NOUNS].join("|")})`;
  const target = `(?:the )?${control.value}(?: button| link)?`;
  const rankedTarget = `(?:the )?${relation}`;
  return new RegExp(
    `^(?:(?:please )?(?:click|tap|press|open|select|choose) )?(?:` +
      `${rankedTarget} ${target}|${target} (?:for|on|of) ${rankedTarget}(?: ${noun})?|` +
      `${target} ${rankedTarget} ${noun}|${rankedTarget} ${noun}(?: s)? ${target})$`,
  );
}

function rankedRoleGroup(
  group: readonly Candidate[],
  request: LexicalText,
  control: LexicalText,
): Candidate[] {
  const kind = new RegExp(`${control.value} (button|link)(?: |$)`).exec(
    request.value,
  )?.[1];
  return filterByRole(group, kind);
}

function isValidRankedForm(
  form: RegExp,
  request: LexicalText,
  ranked: RankedRequest,
): boolean {
  if (!form.test(request.value)) return false;
  return !ranked.lowest || !ranked.highest;
}

function filterByRole(
  group: readonly Candidate[],
  role: string | undefined,
): Candidate[] {
  return role ? group.filter((member) => member.role === role) : [...group];
}

function rankingPattern(ranked: RankedRequest): string {
  if (ranked.ordinal) return ranked.ordinal;
  return ranked.lowest
    ? "(?:cheapest|lowest price(?:d)?|least expensive)"
    : "(?:most expensive|highest price(?:d)?|priciest)";
}

function selectByPrice(
  group: readonly Candidate[],
  items: readonly string[],
  lowest: boolean,
): Candidate | null {
  const prices = items.map((text) => {
    const found = new Set(
      (text.match(MONEY) ?? []).map((value) =>
        Number(value.replace(/[^\d.]/g, "")),
      ),
    );
    return found.size === 1 ? [...found][0]! : NaN;
  });
  if (prices.some(Number.isNaN)) return null;
  const target = lowest ? Math.min(...prices) : Math.max(...prices);
  const matches = prices.flatMap((price, index) =>
    price === target ? [index] : [],
  );
  return matches.length === 1 ? group[matches[0]!]! : null;
}

function matchItemReference(context: GroupContext): Candidate | null {
  const reference = /\b(?:for|on|about|of|from|under|by)\s+(.+)$/i.exec(
    context.sentence.withoutTemplates().value,
  );
  if (!reference) return null;
  if (!hasReferenceItems(context)) return null;
  const phrase = new LexicalText(reference[0].toLocaleLowerCase());
  if (hasCandidateContaining(context.candidates, phrase)) return null;
  const wanted = referenceWords(new LexicalText(reference[1]!), context);
  if (!wanted.length) return null;
  const matching = context.group.filter((member, index) =>
    itemContainsReference(member, index, wanted, context.items),
  );
  return hasSingleMatch(matching) ? matching[0] : null;
}

function hasReferenceItems(context: GroupContext): boolean {
  if (context.group.every((member) => !!member.signals.item)) return true;
  return context.loose && context.items.filter(Boolean).length >= 2;
}

function referenceWords(phrase: LexicalText, context: GroupContext): string[] {
  const label = new Set(new LexicalText(context.pick.name).words());
  return phrase.words().filter((word) => {
    if (word.length <= 1 || FILLER_WORDS.has(word)) return false;
    if (ITEM_NOUNS.has(word) || label.has(word)) return false;
    return !context.loose || !REFERENCE_WORDS.has(word);
  });
}

function itemContainsReference(
  member: Candidate,
  index: number,
  wanted: readonly string[],
  items: readonly string[],
): boolean {
  if (!items[index]) return false;
  const own = new Set(new LexicalText(member.name).words());
  const text = new Set(
    new LexicalText(items[index]!).words().filter((word) => !own.has(word)),
  );
  return wanted.every((word) => text.has(word));
}

function hasCandidateContaining(
  candidates: readonly Candidate[],
  phrase: LexicalText,
): boolean {
  return candidates.some((candidate) =>
    candidate.name.toLocaleLowerCase().includes(phrase.value),
  );
}

function rankedSelection(
  ranked: RankedRequest,
  group: readonly Candidate[],
  items: readonly string[],
): Candidate | null | undefined {
  if (ranked.ordinal) {
    const ordinal = ORDINALS[ranked.ordinal]!;
    const index = ordinal === -1 ? group.length - 1 : ordinal - 1;
    return index < group.length ? group[index]! : null;
  }
  if (!ranked.lowest && !ranked.highest) return undefined;
  if (!group.every((member) => !!member.signals.item)) return null;
  return selectByPrice(group, items, ranked.lowest);
}

export function resolveInCode(
  sentence: string,
  pick: Candidate,
  candidates: readonly Candidate[],
  loose = false,
): Candidate | null {
  const context: ResolutionContext = {
    sentence: new LexicalText(sentence),
    pick,
    candidates,
    loose,
  };
  let group = inNamedRegion(
    sentence,
    candidates.filter(
      (candidate) =>
        candidateName(candidate, loose) === candidateName(pick, loose),
    ),
  );
  if (group.length < 2 || !group.includes(pick)) return null;
  const said = new LexicalText(sentence).withoutTemplates().words();
  const referenceAt = said.findIndex((word) =>
    /^(for|on|about|of|from|under|by)$/.test(word),
  );
  const ranked = parseOrdinalPriceRequest(sentence, pick, loose, referenceAt);
  const parsed = rankedRequestGroup(ranked, pick, group, loose);
  if (!parsed) return null;
  group = parsed.group;
  const items = group.map((member) => member.signals.item ?? "");
  if (
    items.some((text) =>
      /\b(sponsored|promoted|pinned|advertisement)\b/i.test(text),
    )
  )
    return null;
  const selected = rankedSelection(ranked, group, items);
  if (selected !== undefined) return selected;
  return matchItemReference({ ...context, group, items });
}

export function statedGroupPick(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate | null {
  const request = new StatedGroupRequest(sentence, candidates);
  const matches = candidates.flatMap((candidate) => request.match(candidate));
  const longest = Math.max(0, ...matches.map((match) => match.size));
  const best = matches.filter((match) => match.size === longest);
  return hasSingleMatch(best) ? best[0].pick : null;
}

interface StatedMatch {
  readonly key: string;
  readonly size: number;
  readonly pick: Candidate;
}

class StatedGroupRequest {
  readonly #said: ReadonlySet<string>;
  readonly #counts: ReadonlyMap<string, number>;
  readonly #seen = new Set<string>();

  constructor(sentence: string, candidates: readonly Candidate[]) {
    this.#said = new Set(new LexicalText(sentence).withoutTemplates().words());
    const counts = new Map<string, number>();
    for (const candidate of candidates) {
      const key = maskedName(candidate.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.#counts = counts;
  }

  match(candidate: Candidate): StatedMatch[] {
    const key = maskedName(candidate.name);
    const own = statedContent(new LexicalText(key));
    if (!this.#isMatch(candidate, key, own)) return [];
    this.#seen.add(key);
    return [{ key, size: own.length, pick: candidate }];
  }

  #isMatch(candidate: Candidate, key: string, own: readonly string[]): boolean {
    if (candidate.signals.nameTruncated || this.#seen.has(key)) return false;
    if ((this.#counts.get(key) ?? 0) < 2 || own.length === 0) return false;
    return own.every((word) => this.#said.has(word));
  }
}

function statedContent(name: LexicalText): string[] {
  return new LexicalText(name.value.replace("#", " "))
    .words()
    .filter((word) => !FILLER_WORDS.has(word) && !NAVIGATION_VERBS.has(word));
}

export function nameStated(sentence: string, candidate: Candidate): boolean {
  const said = new Set(new LexicalText(sentence).words());
  const own = statedContent(new LexicalText(maskedName(candidate.name)));
  return own.length > 0 && own.every((word) => said.has(word));
}

export function codeAfterNone(
  sentence: string,
  candidates: readonly Candidate[],
): Candidate | null {
  const pick = statedGroupPick(sentence, candidates);
  return pick ? resolveInCode(sentence, pick, candidates, true) : null;
}

export function itemQuestionGroup(
  sentence: string,
  pick: Candidate,
  candidates: readonly Candidate[],
): Candidate[] | null {
  const reference = itemReference(sentence, candidates);
  if (!reference) return null;
  const name = maskedName(pick.name);
  const group = inNamedRegion(
    sentence,
    candidates.filter((candidate) => maskedName(candidate.name) === name),
  );
  if (!group.includes(pick) || !pick.signals.item) return null;
  const members = group.filter((member) => !!member.signals.item?.trim());
  return isVerifiableGroup(members) ? members : null;
}

function itemReference(
  sentence: string,
  candidates: readonly Candidate[],
): RegExpExecArray | null {
  const reference = REFERENCE_PHRASE.exec(
    new LexicalText(sentence).withoutTemplates().value,
  );
  if (!reference || ORDINAL_OR_PRICE.test(reference[1]!)) return null;
  const phrase = new LexicalText(reference[0].toLocaleLowerCase());
  return hasCandidateContaining(candidates, phrase) ? null : reference;
}

function isVerifiableGroup(members: readonly Candidate[]): boolean {
  return members.length >= 2 && members.length <= MAX_VERIFIED_ITEMS;
}

export function resolveBySection(
  sentence: string,
  pick: Candidate,
  candidates: readonly Candidate[],
): Candidate | null {
  const text = new LexicalText(sentence).withoutTemplates();
  if (!/\b(in|under|inside|within|from|below|beneath|of)\b/i.test(text.value))
    return null;
  const name = pick.name.trim().toLocaleLowerCase();
  const group = inNamedRegion(
    sentence,
    candidates.filter(
      (candidate) => candidate.name.trim().toLocaleLowerCase() === name,
    ),
  );
  if (group.length < 2 || !group.includes(pick)) return null;
  const wanted = sectionWords(text, pick);
  if (!wanted.length) return null;
  const matching = group.filter((member) => {
    const section = new Set(
      new LexicalText(member.signals.section ?? "").stemmedWords(),
    );
    return wanted.every((word) => section.has(word));
  });
  return hasSingleMatch(matching) ? matching[0] : null;
}

function sectionWords(text: LexicalText, pick: Candidate): string[] {
  const label = new Set(new LexicalText(pick.name).stemmedWords());
  const filler = new Set(
    [...FILLER_WORDS, ...SECTION_NOUNS].flatMap((word) =>
      new LexicalText(word).stemmedWords(),
    ),
  );
  return [
    ...new Set(
      text
        .stemmedWords()
        .filter((word) => !label.has(word) && !filler.has(word)),
    ),
  ];
}

export function lexicalMiss(
  sentence: string,
  selected: Candidate,
  offered: readonly Candidate[],
): boolean {
  const content = new LexicalText(sentence)
    .withoutTemplates()
    .words()
    .filter((word) => !FILLER_WORDS.has(word));
  if (!content.length) return false;
  const picked = new Set(new LexicalText(selected.name).words());
  if (content.some((word) => picked.has(word))) return false;
  return offered.some((candidate) => {
    if (candidate === selected) return false;
    const name = new Set(new LexicalText(candidate.name).words());
    return content.every((word) => name.has(word));
  });
}
