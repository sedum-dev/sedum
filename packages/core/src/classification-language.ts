import type {
  ClassificationDiagnosticCode,
  StepOperationKind,
} from "./classification-contracts.js";

const PLACEHOLDER = String.raw`\{\{\s*[A-Za-z_]\w*\s*\}\}`;
const VALUE = new RegExp(
  `^(?:type|enter|fill)\\s+(?:"[^"]*"|${PLACEHOLDER})\\s+(?:in|into)\\s+\\S`,
  "iu",
);
const VALUE_OPERAND = new RegExp(
  `("[^"]*"|${PLACEHOLDER})\\s+(?:in|into)\\s+\\S`,
  "giu",
);
const BINDING = new RegExp(`\\bas\\s+${PLACEHOLDER}\\s*\\.?$`, "iu");
const HTTP_URL = /https?:\/\/\S+/giu;
const WAIT_DURATION =
  /^wait\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\s*\.?$/iu;
/**
 * `wait until the reply is shown`, or `wait up to 90 seconds until …`: a
 * verify that judges the claim again as the page changes, until it holds.
 */
export const WAIT_UNTIL =
  /^wait\s+(?:up\s+to\s+\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\s+)?(?:until|for)\s+(?!\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?)\s*\.?$)\S/iu;
const HISTORY_MOVE =
  /^(?:(?:go|navigate)\s+(?:back(?:\s+to\s+the\s+previous\s+page)?|forward)|(?:reload|refresh)(?:\s+the\s+page)?)\s*\.?$/iu;
const DURATION_OPERAND =
  /\b(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/giu;
const KNOWN_KEY =
  /\b(?:Enter|Tab|Escape|Esc|Space|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-2]))\b/giu;
const SECOND_ACTION_CONNECTOR =
  /\b(and|or|but|then|after|before|while|once|when|until|afterwards|subsequently|next|later|finally|followed\s+by|as\s+soon\s+as)\b\s+/giu;
const SECOND_INTERACTION =
  /\b(?:click(?:s|ed|ing)?|typ(?:e|es|ed|ing)|enter(?:s|ed|ing)?|fill(?:s|ed|ing)?|press(?:es|ed|ing)?|scroll(?:s|ed|ing)?|select(?:s|ed|ing)?|submit(?:s|ted|ting)?|tap(?:s|ped|ping)?|navigat(?:e|es|ed|ing)|go(?:es|ing)?|open(?:s|ed|ing)?|upload(?:s|ed|ing)?|download(?:s|ed|ing)?|drag(?:s|ged|ging)?|drop(?:s|ped|ping)?|log(?:s|ged|ging)?\s+in|sign(?:s|ed|ing)?\s+in|verify|assert|check|confirm|ensure|expect|measure|note|observe|wait|remember|capture|record)\b/iu;
const ACTOR_SECOND_ACTION = new RegExp(
  `^(?:you|we|I|they|(?:the|a)\\s+user)\\s+${SECOND_INTERACTION.source}`,
  "iu",
);
const ADVERB_SECOND_ACTION = new RegExp(
  `^(?:(?:also|then|afterwards|later|next|finally|immediately|please|now|first)\\s+)+(?:(?:you|we|I|they|(?:the|a)\\s+user)\\s+)?${SECOND_INTERACTION.source}`,
  "iu",
);
const GERUND_SECOND_ACTION =
  /^(?:clicking|typing|entering|filling|pressing|scrolling|selecting|submitting|tapping|navigating|uploading|downloading|dragging|dropping|verifying|checking|measuring|waiting|remembering|opening(?!\s+(?:hours|times)\b))\b/iu;
const PASSIVE_INTERACTION =
  /\b(?:is|are|was|were|has|have|had)(?:\s+been)?\s+(?:clicked|typed|entered|filled|pressed|scrolled|selected|submitted|opened|uploaded|downloaded)\b/iu;
const ACTION_VERBS =
  "click|type|enter|fill|press|goto|go\\s+to|navigate|verify|assert|measure|note|observe|scroll|wait|remember|capture|record|select|tap|activate|close|drag|drop|upload|download|hover|swipe|double[ -]?click|right[ -]?click";
const DIRECT_SECOND_ACTION = new RegExp(`^(?:${ACTION_VERBS})\\b`, "iu");
const CLAIM_PREDICATE =
  /\b(is|are|was|were|contains|includes|shows|displays|reads|says|matches|appears|exists|remains|looks)\b/iu;
const CLAIM_SUBJECT_WORD =
  /^(?:the|a|an|this|that|these|those|there|it|I|we|you|they)\b/iu;
const BOUND_CLAIM_SUBJECT = /^(?:["']|\{\{)/u;
const CLAIM_STATE =
  /^(?:not\s+)?(?:(?:being\s+)?shown|visible|hidden|ready|complete|completed|open|closed|enabled|disabled|selected|checked|empty|available|present|absent|active|inactive|valid|invalid|successful|failed|loading|displayed|focused|required|expanded|collapsed|on|off|correct|incorrect)$/iu;
const CLAIM_VALUE =
  /^(?:""|''|\{\{\s*[A-Za-z_]\w*\s*\}\}|true|false|[£$€¥]?\s*[+-]?\d+(?:[.,]\d+)?%?)$/iu;
const UNSUPPORTED_START =
  /^(?:drag|drop|upload|download|hover|swipe|double[ -]?click|right[ -]?click)\b/iu;
const ASSERTION_START =
  /^(?:verify|assert|check|confirm|ensure|expect|measure|note|observe)\b/iu;
const SIDE_EFFECT_START =
  /^(?:click|type|enter|fill|press|goto|go\s+to|navigate\s+to|scroll|wait|remember|select|choose|pick)\b/iu;
const MULTIPLE_CLAUSE = /;|,\s*[A-Za-z]/u;
const CLICK_PATTERN = /^click\s+\S/iu;
const PRESS_PATTERN = /^press\s+(?:the\s+)?(?:"[^"]+"|\S+)/iu;
const VERIFY_PATTERN = /^(?:verify|assert|check|confirm|ensure|expect)\s+\S/iu;
const MEASURE_PATTERN = /^(?:measure|note|observe)\s+\S/iu;

export function canonicalSentence(sentence: string): string {
  return sentence.normalize("NFC").replace(/\s+/gu, " ").trim();
}

interface SentenceSyntax {
  readonly text: string;
  readonly exposed: string;
}

interface ClaimTail {
  readonly predicate: string;
  readonly tail: string;
}

interface SecondActionClause {
  readonly tail: string;
  readonly assertion: boolean;
}

const EMPTY_CLAIM_PREDICATES = new Set(["appears", "exists"]);
const VALUE_CLAIM_PREDICATES = new Set([
  "contains",
  "includes",
  "shows",
  "displays",
  "reads",
  "says",
  "matches",
]);

function analyzeSentence(sentence: string): SentenceSyntax {
  const text = canonicalSentence(sentence);
  return {
    text,
    exposed: text.replace(/"[^"]*"|'[^']*'/gu, '""'),
  };
}

function validClaimTail(claim: ClaimTail): boolean {
  const predicate = claim.predicate.toLowerCase();
  if (EMPTY_CLAIM_PREDICATES.has(predicate)) return claim.tail === "";
  if (VALUE_CLAIM_PREDICATES.has(predicate))
    return CLAIM_VALUE.test(claim.tail);
  return CLAIM_STATE.test(claim.tail) || CLAIM_VALUE.test(claim.tail);
}

/** Whether a sentence has a statically recognizable claim shape. */
export function isClaimSentence(sentence: string): boolean {
  const syntax = analyzeSentence(sentence);
  if (
    !CLAIM_SUBJECT_WORD.test(syntax.text) &&
    !BOUND_CLAIM_SUBJECT.test(syntax.text)
  )
    return false;
  const structural = syntax.exposed.replace(/\.$/u, "");
  const predicate = CLAIM_PREDICATE.exec(structural);
  if (!predicate || predicate.index === 0) return false;
  const tail = structural.slice(predicate.index + predicate[0].length).trim();
  return validClaimTail({ predicate: predicate[1]!, tail });
}

function hasDirectFollowUp(syntax: SentenceSyntax): boolean {
  return new RegExp(
    `(?:\\b(?:then|and)\\s+(?:(?:also|then)\\s+)?|[;,]\\s*)(?:${ACTION_VERBS})\\b`,
    "iu",
  ).test(syntax.exposed);
}

function startsSecondAction(clause: SecondActionClause): boolean {
  return (
    ACTOR_SECOND_ACTION.test(clause.tail) ||
    ADVERB_SECOND_ACTION.test(clause.tail) ||
    GERUND_SECOND_ACTION.test(clause.tail) ||
    DIRECT_SECOND_ACTION.test(clause.tail) ||
    (!clause.assertion && PASSIVE_INTERACTION.test(clause.tail))
  );
}

function hasSecondAction(syntax: SentenceSyntax): boolean {
  const assertion = ASSERTION_START.test(syntax.exposed);
  for (const connector of syntax.exposed.matchAll(SECOND_ACTION_CONNECTOR)) {
    const tail = syntax.exposed.slice(connector.index + connector[0].length);
    if (startsSecondAction({ tail, assertion })) return true;
  }
  return false;
}

export function preflightSentence(
  sentence: string,
): ClassificationDiagnosticCode | null {
  const syntax = analyzeSentence(sentence);
  if (!syntax.text) return "empty";
  if (UNSUPPORTED_START.test(syntax.exposed)) return "unsupported";
  if (hasDirectFollowUp(syntax) || hasSecondAction(syntax))
    return "multiple_actions";
  return null;
}

function isNavigation(syntax: SentenceSyntax): boolean {
  return (
    HISTORY_MOVE.test(syntax.text) ||
    /^(?:goto|go\s+to|navigate\s+to)\s+\/\S*\s*$/iu.test(syntax.text)
  );
}

function hasMultipleSideEffectClauses(syntax: SentenceSyntax): boolean {
  if (!SIDE_EFFECT_START.test(syntax.text)) return false;
  return (
    syntax.exposed.match(SECOND_ACTION_CONNECTOR) !== null ||
    MULTIPLE_CLAUSE.test(syntax.exposed)
  );
}

function namedOptionPattern(syntax: SentenceSyntax): boolean {
  return /^(?:select|choose|pick)\s+(?:"[^"]+"|“[^”]+”)\s+(?:in|from)\s+\S/iu.test(
    syntax.text,
  );
}

interface PatternRule {
  readonly operation: StepOperationKind;
  matches(syntax: SentenceSyntax): boolean;
}

const SIMPLE_PATTERN_RULES: readonly PatternRule[] = [
  {
    operation: "remember",
    matches: ({ text }) => /^remember\b/iu.test(text) && BINDING.test(text),
  },
  {
    operation: "click",
    matches: (syntax) =>
      CLICK_PATTERN.test(syntax.text) || namedOptionPattern(syntax),
  },
  { operation: "type", matches: ({ text }) => VALUE.test(text) },
  { operation: "press", matches: ({ text }) => PRESS_PATTERN.test(text) },
  {
    operation: "goto",
    matches: ({ text }) =>
      /^(?:goto|go\s+to|navigate\s+to)\s+https?:\/\/\S+/iu.test(text),
  },
  { operation: "verify", matches: ({ text }) => VERIFY_PATTERN.test(text) },
  { operation: "measure", matches: ({ text }) => MEASURE_PATTERN.test(text) },
  {
    operation: "scroll",
    matches: ({ text }) => /^scroll\s+(?:up|down)\b/iu.test(text),
  },
  { operation: "wait", matches: ({ text }) => WAIT_DURATION.test(text) },
];

function simplePatternOperation(
  syntax: SentenceSyntax,
): StepOperationKind | null {
  return (
    SIMPLE_PATTERN_RULES.find((rule) => rule.matches(syntax))?.operation ?? null
  );
}

export function patternOperation(sentence: string): StepOperationKind | null {
  const syntax = analyzeSentence(sentence);
  if (preflightSentence(syntax.text)) return null;
  if (WAIT_UNTIL.test(syntax.text)) return "verify";
  if (isNavigation(syntax)) return "goto";
  if (hasMultipleSideEffectClauses(syntax)) return null;
  return simplePatternOperation(syntax);
}

function validateClick(syntax: SentenceSyntax): string | null {
  return /^\S+\s+\S/iu.test(syntax.text)
    ? null
    : "Name one page element to click.";
}

function validateType({ text }: SentenceSyntax): string | null {
  const quotedSpans = [...text.matchAll(/"[^"]*"/gu)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const operand = [...text.matchAll(VALUE_OPERAND)].find(
    (match) =>
      !quotedSpans.some(
        (span) => match.index > span.start && match.index < span.end,
      ),
  );
  const beforeField = operand
    ? text.slice(0, operand.index + operand[1]!.length)
    : "";
  const quotes = beforeField.match(/"[^"]*"/gu) ?? [];
  const placeholders =
    beforeField.replace(/"[^"]*"/gu, "").match(new RegExp(PLACEHOLDER, "gu")) ??
    [];
  if (operand && quotes.length + placeholders.length === 1) return null;
  return 'Name one value, such as {{key}} or "{{user}}@example.com", and a field.';
}

function validateGoto(syntax: SentenceSyntax): string | null {
  if (isNavigation(syntax)) return null;
  const urls = syntax.text.match(HTTP_URL) ?? [];
  return urls.length === 1
    ? null
    : "Name exactly one http(s) address or a /path on this site.";
}

function validatePress({ text }: SentenceSyntax): string | null {
  const explicit =
    /^(?:press|hit|strike)\s+(?:the\s+)?(?:"[^"]+"|[\w-]+)(?:\s+key)?\s*\.?$/iu.test(
      text,
    );
  const namedKeys = [...text.matchAll(KNOWN_KEY)];
  const keyMentions = [...text.matchAll(/(?:"[^"]+"|[\w-]+)\s+key\b/giu)];
  const hasOneKey = namedKeys.length === 1 || keyMentions.length === 1;
  const hasMultipleKeys = namedKeys.length > 1 || keyMentions.length > 1;
  return (explicit || hasOneKey) && !hasMultipleKeys
    ? null
    : "Name exactly one key to press.";
}

function validateRemember({ text }: SentenceSyntax): string | null {
  if (!BINDING.test(text)) return "End the read with as {{a_name}}.";
  const bindings = text.match(/\bas\s+\{\{/giu) ?? [];
  return bindings.length === 1 ? null : "Bind exactly one remembered value.";
}

function validateWait({ text }: SentenceSyntax): string | null {
  const durations = [...text.matchAll(DURATION_OPERAND)];
  if (durations.length !== 1)
    return "Name one duration, such as wait for 2 seconds.";
  const duration = durations[0]!;
  const amount = Number(duration[1]);
  const durationMs = duration[2]!.toLowerCase().startsWith("m")
    ? amount
    : amount * 1000;
  return durationMs > 0 && durationMs <= 30_000
    ? null
    : "Use a positive wait duration of at most 30 seconds.";
}

function validateScroll({ text }: SentenceSyntax): string | null {
  return [...text.matchAll(/\b(?:up|down)\b/giu)].length === 1
    ? null
    : "Say scroll up or scroll down.";
}

function validateCompleteSentence({ text }: SentenceSyntax): string | null {
  return /^\S+\s+\S/iu.test(text)
    ? null
    : "Complete the sentence with one claim or action.";
}

type OperandValidator = (syntax: SentenceSyntax) => string | null;

const OPERAND_VALIDATORS: Readonly<
  Record<StepOperationKind, OperandValidator>
> = {
  click: validateClick,
  type: validateType,
  goto: validateGoto,
  press: validatePress,
  remember: validateRemember,
  wait: validateWait,
  scroll: validateScroll,
  verify: validateCompleteSentence,
  measure: validateCompleteSentence,
};

/** Validate the lexical operands that cannot safely be guessed by execution. */
export function validateOperand(
  sentence: string,
  op: StepOperationKind,
): string | null {
  return OPERAND_VALIDATORS[op](analyzeSentence(sentence));
}
