import type { Candidate } from "./page-protocol.js";

type Control = Pick<Candidate, "ref" | "name" | "role">;

/** Action and field words describe the request, never the target's context. */
const COMMAND_WORDS = new Set([
  "add",
  "buy",
  "click",
  "press",
  "select",
  "choose",
  "open",
  "tap",
  "cart",
  "item",
  "product",
  "the",
  "and",
  "with",
  "for",
  "type",
  "fill",
  "enter",
  "write",
  "field",
  "input",
  "box",
]);

/** The noun that names a control of this role, as in "the Checkout button". */
const CONTROL_NOUNS: ReadonlyMap<string, string> = new Map([
  ["button", "button"],
  ["link", "link"],
]);

export function words(value: string): string[] {
  return (
    value
      .normalize("NFC")
      .toLowerCase()
      .match(/\p{L}[\p{L}\p{N}]*/gu) ?? []
  );
}

function sentenceWords(sentence: string): string[] {
  return words(sentence.replace(/\{\{[^{}]+\}\}/gu, " "));
}

function besideLabel(
  tokens: readonly string[],
  index: number,
  label: readonly string[],
): boolean {
  if (tokens[index - 1] === label.at(-1)) return true;
  return tokens[index + 1] === label[0];
}

/** The noun for the control's role, unless its label already contains it. */
function roleNoun(control: Control, label: readonly string[]) {
  const noun = CONTROL_NOUNS.get(control.role);
  if (!noun || label.length === 0) return undefined;
  return label.includes(noun) ? undefined : noun;
}

/** Position of the chosen control's role noun directly after its label's last
 * word or directly before its first; -1 when the sentence has no such noun. */
function roleNounIndex(tokens: readonly string[], control: Control): number {
  const label = words(control.name);
  const noun = roleNoun(control, label);
  if (!noun) return -1;
  return tokens.findIndex(
    (word, index) => word === noun && besideLabel(tokens, index, label),
  );
}

/** Another control of the same role whose own name contains the noun may be
 * what the sentence means, so the noun cannot be dismissed as grammar. */
function claimedByAnother(
  noun: string,
  control: Control,
  candidates: readonly Control[],
): boolean {
  return candidates.some(
    (other) =>
      other.ref !== control.ref &&
      other.role === control.role &&
      words(other.name).includes(noun),
  );
}

function grammaticalNounIndex(
  tokens: readonly string[],
  control: Control,
  candidates: readonly Control[],
): number {
  const index = roleNounIndex(tokens, control);
  if (index < 0) return -1;
  return claimedByAnother(tokens[index]!, control, candidates) ? -1 : index;
}

/** Sentence words that ask for more than the control's own label and role. */
export function contextClues(
  sentence: string,
  control: Control,
  candidates: readonly Control[],
): string[] {
  const tokens = sentenceWords(sentence);
  const label = new Set(words(control.name));
  const grammatical = grammaticalNounIndex(tokens, control, candidates);
  return tokens.filter(
    (word, index) =>
      index !== grammatical &&
      Array.from(word).length >= 3 &&
      !label.has(word) &&
      !COMMAND_WORDS.has(word),
  );
}

/** True when the sentence names the control's role next to its label and
 * another current control's name contains that noun. */
export function contestedControlNoun(
  sentence: string,
  control: Control,
  candidates: readonly Control[],
): boolean {
  const tokens = sentenceWords(sentence);
  const index = roleNounIndex(tokens, control);
  return index >= 0 && claimedByAnother(tokens[index]!, control, candidates);
}
