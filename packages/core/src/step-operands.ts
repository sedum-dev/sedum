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

const CONTROL_NOUN =
  "button|link|field|input|text\\s*box|search\\s*box|box|checkbox|check\\s*box|radio(?:\\s+button)?|toggle|switch|dropdown|select|tab|menu\\s+item|option|icon";
const FIELD_NOUN = /\b(?:field|input|text\s*box|search\s*box|box)$/iu;
const STATE_CLAIM = new RegExp(
  `^(?:the\\s+|a\\s+|an\\s+)?(.+?\\b(?:${CONTROL_NOUN}))\\s+(?:is|are)\\s+(not\\s+)?(shown|visible|displayed|present|enabled|disabled|checked|unchecked|ticked|focused|empty)\\s*\\.?$`,
  "iu",
);
const VALUE_CLAIM = new RegExp(
  `^(?:the\\s+)?(.+?\\b(?:field|input|text\\s*box|search\\s*box|box))\\s+(?:contains|shows|has\\s+the\\s+value|has\\s+value|is\\s+set\\s+to|reads)\\s+(.+?)\\s*\\.?$`,
  "iu",
);

export type ElementExpectation =
  | { readonly kind: "present"; readonly present: boolean }
  | { readonly kind: "disabled"; readonly disabled: boolean }
  | { readonly kind: "checked"; readonly checked: boolean }
  | { readonly kind: "focused"; readonly focused: boolean }
  | { readonly kind: "empty"; readonly empty: boolean }
  | { readonly kind: "value"; readonly value: string };
export interface ElementClaim {
  /** The control as the sentence names it, such as `the Save button`. */
  readonly target: string;
  readonly operation: "click" | "fill";
  readonly expect: ElementExpectation;
}

/**
 * A claim about one control's state, such as `the Save button is disabled`
 * or `the Email field contains {{email}}`. Sedum locates the control and reads
 * its state instead of asking the Judge, since page text carries no control
 * state and field values stay private. Null for any other claim.
 */
export function elementClaim(claim: string): ElementClaim | null {
  const text = canonicalSentence(claim);
  if (/^(?:there\s+is\s+)?no\s+/iu.test(text)) return null;
  const valued = VALUE_CLAIM.exec(text);
  if (valued)
    return {
      target: valued[1]!,
      operation: "fill",
      expect: {
        kind: "value",
        value: valued[2]!.replace(/^(["“'])(.*)(["”'])$/u, "$2"),
      },
    };
  const state = STATE_CLAIM.exec(text);
  if (!state) return null;
  const target = state[1]!;
  const negated = !!state[2];
  const word = state[3]!.toLowerCase();
  const fill = FIELD_NOUN.test(target);
  const expect: ElementExpectation | null = [
    "shown",
    "visible",
    "displayed",
    "present",
  ].includes(word)
    ? negated
      ? null
      : { kind: "present", present: true }
    : word === "enabled"
      ? { kind: "disabled", disabled: negated }
      : word === "disabled"
        ? { kind: "disabled", disabled: !negated }
        : ["checked", "ticked"].includes(word)
          ? { kind: "checked", checked: !negated }
          : word === "unchecked"
            ? { kind: "checked", checked: negated }
            : word === "focused"
              ? { kind: "focused", focused: !negated }
              : word === "empty" && fill
                ? { kind: "empty", empty: !negated }
                : null;
  if (!expect) return null;
  // A disabled field is not a typing target, so it is found as a control.
  return {
    target,
    operation: fill && expect.kind !== "disabled" ? "fill" : "click",
    expect,
  };
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
