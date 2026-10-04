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

function withoutQuotes(sentence: string): string {
  return sentence.replace(/"[^"]*"|'[^']*'/gu, '""');
}

function validClaimTail(predicate: string, tail: string): boolean {
  switch (predicate.toLowerCase()) {
    case "appears":
    case "exists":
      return tail === "";
    case "contains":
    case "includes":
    case "shows":
    case "displays":
    case "reads":
    case "says":
    case "matches":
      return CLAIM_VALUE.test(tail);
    default:
      return CLAIM_STATE.test(tail) || CLAIM_VALUE.test(tail);
  }
}

/** Whether a sentence has a statically recognizable claim shape. */
export function isClaimSentence(sentence: string): boolean {
  const text = canonicalSentence(sentence);
  if (!CLAIM_SUBJECT_WORD.test(text) && !BOUND_CLAIM_SUBJECT.test(text))
    return false;
  const structural = withoutQuotes(text).replace(/\.$/u, "");
  const predicate = CLAIM_PREDICATE.exec(structural);
  if (!predicate || predicate.index === 0) return false;
  const tail = structural.slice(predicate.index + predicate[0].length).trim();
  return validClaimTail(predicate[1]!, tail);
}

function hasDirectFollowUp(exposed: string): boolean {
  return new RegExp(
    `(?:\\b(?:then|and)\\s+(?:(?:also|then)\\s+)?|[;,]\\s*)(?:${ACTION_VERBS})\\b`,
    "iu",
  ).test(exposed);
}

function startsSecondAction(tail: string, assertion: boolean): boolean {
  return (
    ACTOR_SECOND_ACTION.test(tail) ||
    ADVERB_SECOND_ACTION.test(tail) ||
    GERUND_SECOND_ACTION.test(tail) ||
    DIRECT_SECOND_ACTION.test(tail) ||
    (!assertion && PASSIVE_INTERACTION.test(tail))
  );
}

function hasSecondAction(exposed: string): boolean {
  const assertion = ASSERTION_START.test(exposed);
  for (const connector of exposed.matchAll(SECOND_ACTION_CONNECTOR)) {
    const tail = exposed.slice(connector.index + connector[0].length);
    if (startsSecondAction(tail, assertion)) return true;
  }
  return false;
}

export function preflightSentence(
  sentence: string,
): ClassificationDiagnosticCode | null {
  const text = canonicalSentence(sentence);
  if (!text) return "empty";
  const exposed = withoutQuotes(text);
  if (UNSUPPORTED_START.test(exposed)) return "unsupported";
  if (hasDirectFollowUp(exposed) || hasSecondAction(exposed))
    return "multiple_actions";
  return null;
}

function isNavigation(text: string): boolean {
  return (
    HISTORY_MOVE.test(text) ||
    /^(?:goto|go\s+to|navigate\s+to)\s+\/\S*\s*$/iu.test(text)
  );
}

function hasMultipleSideEffectClauses(text: string): boolean {
  if (!SIDE_EFFECT_START.test(text)) return false;
  const exposed = withoutQuotes(text);
  return (
    exposed.match(SECOND_ACTION_CONNECTOR) !== null ||
    MULTIPLE_CLAUSE.test(exposed)
  );
}

function namedOptionPattern(text: string): boolean {
  return /^(?:select|choose|pick)\s+(?:"[^"]+"|“[^”]+”)\s+(?:in|from)\s+\S/iu.test(
    text,
  );
}

function simplePatternOperation(text: string): StepOperationKind | null {
  if (/^remember\b/iu.test(text) && BINDING.test(text)) return "remember";
  if (CLICK_PATTERN.test(text) || namedOptionPattern(text)) return "click";
  if (VALUE.test(text)) return "type";
  if (PRESS_PATTERN.test(text)) return "press";
  if (/^(?:goto|go\s+to|navigate\s+to)\s+https?:\/\/\S+/iu.test(text))
    return "goto";
  if (VERIFY_PATTERN.test(text)) return "verify";
  if (MEASURE_PATTERN.test(text)) return "measure";
  if (/^scroll\s+(?:up|down)\b/iu.test(text)) return "scroll";
  if (WAIT_DURATION.test(text)) return "wait";
  return null;
}

export function patternOperation(sentence: string): StepOperationKind | null {
  const text = canonicalSentence(sentence);
  if (preflightSentence(text)) return null;
  if (WAIT_UNTIL.test(text)) return "verify";
  if (isNavigation(text)) return "goto";
  if (hasMultipleSideEffectClauses(text)) return null;
  return simplePatternOperation(text);
}

function validateClick(text: string): string | null {
  return /^\S+\s+\S/iu.test(text) ? null : "Name one page element to click.";
}

function validateType(text: string): string | null {
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

function validateGoto(text: string): string | null {
  if (isNavigation(text)) return null;
  const urls = text.match(HTTP_URL) ?? [];
  return urls.length === 1
    ? null
    : "Name exactly one http(s) address or a /path on this site.";
}

function validatePress(text: string): string | null {
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

function validateRemember(text: string): string | null {
  if (!BINDING.test(text)) return "End the read with as {{a_name}}.";
  const bindings = text.match(/\bas\s+\{\{/giu) ?? [];
  return bindings.length === 1 ? null : "Bind exactly one remembered value.";
}

function validateWait(text: string): string | null {
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

function validateScroll(text: string): string | null {
  return [...text.matchAll(/\b(?:up|down)\b/giu)].length === 1
    ? null
    : "Say scroll up or scroll down.";
}

function validateCompleteSentence(text: string): string | null {
  return /^\S+\s+\S/iu.test(text)
    ? null
    : "Complete the sentence with one claim or action.";
}

/** Validate the lexical operands that cannot safely be guessed by execution. */
export function validateOperand(
  sentence: string,
  op: StepOperationKind,
): string | null {
  const text = canonicalSentence(sentence);
  switch (op) {
    case "click":
      return validateClick(text);
    case "type":
      return validateType(text);
    case "goto":
      return validateGoto(text);
    case "press":
      return validatePress(text);
    case "remember":
      return validateRemember(text);
    case "wait":
      return validateWait(text);
    case "scroll":
      return validateScroll(text);
    case "verify":
    case "measure":
      return validateCompleteSentence(text);
  }
}
