import { canonicalSentence, WAIT_UNTIL } from "./classification.js";

/**
 * Operand extraction for the operations that need no locator. Classification
 * has already validated each sentence's shape; these read the one operand
 * that validation accepted, or return null when it is not there.
 */

const PLAYWRIGHT_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `f${index + 1}`,
      `F${index + 1}`,
    ]),
  ),
};
const MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: "Control",
  control: "Control",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  controlormeta: "ControlOrMeta",
};

function playwrightKey(name: string): string | null {
  const parts = name.trim().split(/\s*\+\s*/u);
  if (parts.some((part) => !part)) return null;
  const key = parts.pop()!;
  const modifiers = parts.map((part) => MODIFIERS[part.toLowerCase()]);
  if (modifiers.some((modifier) => modifier === undefined)) return null;
  const main =
    PLAYWRIGHT_KEYS[key.toLowerCase()] ??
    (Array.from(key).length === 1 ? key : null);
  return main ? [...modifiers, main].join("+") : null;
}

/** `press Enter`, `press the "Control+A" key`, `press the Escape key`. */
export function pressKey(sentence: string): string | null {
  const text = canonicalSentence(sentence);
  const quoted = /"([^"]+)"/u.exec(text);
  if (quoted) return playwrightKey(quoted[1]!);
  const keyMention = /\b([\w+-]+)\s+key\b/iu.exec(text);
  if (keyMention) return playwrightKey(keyMention[1]!);
  const explicit = /^(?:press|hit|strike)\s+(?:the\s+)?([\w+-]+)\s*\.?$/iu.exec(
    text,
  );
  return explicit ? playwrightKey(explicit[1]!) : null;
}

/** `wait 1 second`, `wait for 500 ms`; the classifier bounds it to 30 s. */
export function waitDurationMs(sentence: string): number | null {
  const match = /\b(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?)\b/iu.exec(
    canonicalSentence(sentence),
  );
  if (!match) return null;
  const amount = Number(match[1]);
  const ms = match[2]!.toLowerCase().startsWith("m") ? amount : amount * 1000;
  return Number.isFinite(ms) && ms > 0 && ms <= 30_000 ? Math.round(ms) : null;
}

/** `scroll down` or `scroll up`. */
export function scrollDirection(sentence: string): "up" | "down" | null {
  const match = /\b(up|down)\b/iu.exec(canonicalSentence(sentence));
  return match ? (match[1]!.toLowerCase() as "up" | "down") : null;
}

/**
 * The one http(s) address in a goto sentence, split around `{{name}}`
 * placeholders so data values can be substituted without being displayed.
 */
export function gotoUrlParts(
  sentence: string,
): { readonly literals: string[]; readonly names: string[] } | null {
  const urls = canonicalSentence(sentence).match(/https?:\/\/\S+/giu) ?? [];
  if (urls.length !== 1) return null;
  // A trailing period ends the sentence, not the address.
  const url = urls[0]!.replace(/[.,;]+$/u, "");
  const literals: string[] = [];
  const names: string[] = [];
  let rest = url;
  for (;;) {
    const match = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/u.exec(rest);
    if (!match) break;
    literals.push(rest.slice(0, match.index));
    names.push(match[1]!);
    rest = rest.slice(match.index + match[0].length);
  }
  literals.push(rest);
  return { literals, names };
}

export const WAIT_UNTIL_DEFAULT_MS = 30_000;
export const WAIT_UNTIL_MAX_MS = 120_000;
/**
 * How long a `wait until …` step may keep judging its claim, or null for any
 * other sentence. `wait up to 90 seconds until …` sets the limit.
 */
export function waitUntilTimeoutMs(sentence: string): number | null {
  const text = canonicalSentence(sentence);
  if (!WAIT_UNTIL.test(text)) return null;
  const limit = /^wait\s+up\s+to\s+(\d+(?:\.\d+)?)/iu.exec(text);
  if (!limit) return WAIT_UNTIL_DEFAULT_MS;
  return Math.min(WAIT_UNTIL_MAX_MS, Math.max(1_000, Number(limit[1]) * 1000));
}

/** `go back`, `go forward`, `reload the page`: a move in the browser history. */
export function historyMove(
  sentence: string,
): "back" | "forward" | "reload" | null {
  const text = canonicalSentence(sentence).replace(/\.$/u, "");
  if (/^(?:go|navigate)\s+back(?:\s+to\s+the\s+previous\s+page)?$/iu.test(text))
    return "back";
  if (/^(?:go|navigate)\s+forward$/iu.test(text)) return "forward";
  if (/^(?:reload|refresh)(?:\s+the\s+page)?$/iu.test(text)) return "reload";
  return null;
}

/**
 * `goto /practice/clients/{{id}}`: a path on the current site, split like
 * {@link gotoUrlParts}. The runner puts the page's origin in front.
 */
export function gotoPathParts(
  sentence: string,
): { readonly literals: string[]; readonly names: string[] } | null {
  const path = /^(?:goto|go\s+to|navigate\s+to|open)\s+(\/\S*)\s*$/iu.exec(
    canonicalSentence(sentence),
  )?.[1];
  if (!path) return null;
  const literals: string[] = [];
  const names: string[] = [];
  let rest = path.replace(/[.,;]+$/u, "");
  for (;;) {
    const match = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/u.exec(rest);
    if (!match) break;
    literals.push(rest.slice(0, match.index));
    names.push(match[1]!);
    rest = rest.slice(match.index + match[0].length);
  }
  literals.push(rest);
  return { literals, names };
}
