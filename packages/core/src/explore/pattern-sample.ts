import type { SeededRandom } from "./random.js";

/** One position of a simple pattern: the characters it allows, and how many. */
interface Atom {
  readonly chars: string;
  readonly min: number;
  readonly max: number;
}

const DIGITS = "0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = UPPER.toLowerCase();
const ESCAPES: Readonly<Record<string, string>> = {
  d: DIGITS,
  w: `${UPPER}${LOWER}${DIGITS}_`,
  s: " ",
};

function range(from: string, to: string): string {
  let chars = "";
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code++)
    chars += String.fromCharCode(code);
  return chars;
}

/** Reads a simple pattern left to right; null for anything richer. */
class PatternReader {
  #at = 0;

  constructor(private readonly pattern: string) {}

  atoms(): Atom[] | null {
    const atoms: Atom[] = [];
    while (this.#at < this.pattern.length) {
      const chars = this.#chars();
      if (!chars) return null;
      atoms.push({ chars, ...this.#count() });
    }
    return atoms;
  }

  #chars(): string | null {
    const c = this.pattern[this.#at++]!;
    if (c === "[") return this.#class();
    if (c === "\\") return this.#escape();
    return "()|.^$".includes(c) ? null : c;
  }

  #escape(): string {
    const next = this.pattern[this.#at++] ?? "";
    return ESCAPES[next] ?? next;
  }

  /** A class body such as `A-Z0-9`; negated classes are not sampled. */
  #class(): string | null {
    if (this.pattern[this.#at] === "^") return null;
    let chars = "";
    while (this.#at < this.pattern.length && this.pattern[this.#at] !== "]")
      chars += this.#classPart();
    this.#at++;
    return chars || null;
  }

  #classPart(): string {
    const c = this.pattern[this.#at++]!;
    if (c === "\\") return this.#escape();
    const isRange =
      this.pattern[this.#at] === "-" && this.pattern[this.#at + 1] !== "]";
    if (!isRange) return c;
    const end = this.pattern[this.#at + 1]!;
    this.#at += 2;
    return range(c, end);
  }

  #count(): { min: number; max: number } {
    const c = this.pattern[this.#at];
    const short = { "?": [0, 1], "+": [1, 3], "*": [0, 3] }[c ?? ""];
    if (short) {
      this.#at++;
      return { min: short[0]!, max: short[1]! };
    }
    const braces = /^\{(\d+)(,(\d*))?\}/u.exec(this.pattern.slice(this.#at));
    if (!braces) return { min: 1, max: 1 };
    this.#at += braces[0].length;
    const min = Number(braces[1]);
    if (!braces[2]) return { min, max: min };
    return { min, max: Number(braces[3] || min + 3) };
  }
}

function sample(atoms: readonly Atom[], random: SeededRandom): string {
  return atoms
    .map((atom) => {
      let out = "";
      for (let n = random.int(atom.min, atom.max); n > 0; n--)
        out += atom.chars[random.int(0, atom.chars.length - 1)];
      return out;
    })
    .join("");
}

/**
 * A value for a simple HTML `pattern` (classes, escapes, literals and
 * quantifiers), checked against the pattern; null for anything richer.
 */
export function samplePattern(
  pattern: string,
  random: SeededRandom,
): string | null {
  const atoms = new PatternReader(pattern).atoms();
  if (!atoms?.length) return null;
  const value = sample(atoms, random);
  try {
    return new RegExp(`^(?:${pattern})$`, "v").test(value) ? value : null;
  } catch {
    return null;
  }
}

/** "must be 10 digits" → ten digits; "at least 8 characters" → eight letters. */
export function valueForError(
  error: string,
  random: SeededRandom,
): string | null {
  const found =
    /(\d+)\s*(?:-\s*)?(digit|number|numeric|character|letter|char)s?/iu.exec(
      error,
    );
  if (!found)
    return /\b(number|numeric|amount)\b/iu.test(error)
      ? String(random.int(100, 99_999))
      : null;
  const length = Math.min(64, Number(found[1]));
  const chars = /digit|number|numeric/iu.test(found[2]!) ? DIGITS : UPPER;
  return sample([{ chars, min: length, max: length }], random);
}
