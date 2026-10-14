import type { SeededRandom } from "./random.js";

/**
 * Code point ranges and weights for unconstrained text: mostly ASCII, with Latin-1, combining marks, zero-width and
 * bidi controls, Arabic, Hebrew, full-width forms, CJK punctuation, emoji and
 * private-use characters.
 */
const TEXT_RANGES: readonly (readonly [number, number, number])[] = [
  [0x41, 0x5a, 30],
  [0x61, 0x7a, 30],
  [0x30, 0x39, 15],
  [0x20, 0x2f, 10],
  [0x3a, 0x40, 10],
  [0x5b, 0x60, 10],
  [0x7b, 0x7e, 10],
  [0xa0, 0xff, 8],
  [0x100, 0x17f, 5],
  [0x300, 0x36f, 8],
  [0x200b, 0x200f, 8],
  [0x2000, 0x206f, 6],
  [0xfff0, 0xfffd, 5],
  [0x600, 0x6ff, 5],
  [0x590, 0x5ff, 5],
  [0xff01, 0xff60, 5],
  [0x3000, 0x303f, 4],
  [0x1f300, 0x1f9ff, 6],
  [0xe000, 0xf8ff, 3],
];
const TEXT_WEIGHT = TEXT_RANGES.reduce((sum, [, , weight]) => sum + weight, 0);

/** Short strings known to break naive text handling. */
const HOSTILE = [
  "‮txt.exe",
  "zero​width‍join",
  "﻿bom",
  "Z̷͑a̶͒l̴̓g̸͐o",
  "\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}",
  "مرحبا بالعالم",
  "שלום עולם",
  "日本語のテキスト",
  "' OR 1=1 --",
  "<img src=x onerror=alert(1)>",
  "{{7*7}}${7*7}",
  "-1",
  "1e309",
  "NaN",
  "   ",
  "A".repeat(512),
];

function textCodePoint(random: SeededRandom): number {
  let roll = random.next() * TEXT_WEIGHT;
  for (const [low, high, weight] of TEXT_RANGES) {
    if (roll < weight) return random.int(low, high);
    roll -= weight;
  }
  return 0x61;
}

/** Unconstrained text, as a blind random walk would type it. */
export function randomText(random: SeededRandom, maxLength = 40): string {
  const length = random.int(1, maxLength);
  return Array.from({ length }, () =>
    String.fromCodePoint(textCodePoint(random)),
  ).join("");
}

/** A hostile string: a known breaker, sometimes wrapped in plain text. */
export function hostileText(random: SeededRandom): string {
  const core = random.pick(HOSTILE);
  return random.next() < 0.5 ? core : `test ${core} value`;
}

function randomWord(random: SeededRandom, length: number): string {
  return Array.from({ length }, () =>
    String.fromCharCode(random.int(0x61, 0x7a)),
  ).join("");
}

/**
 * Per-type defaults: emails look like emails, numbers are digits,
 * everything else is unconstrained text.
 */
export function blindValue(random: SeededRandom, inputType: string): string {
  if (inputType === "email")
    return `${randomWord(random, random.int(3, 10))}@${randomWord(random, 6)}.test`;
  if (inputType === "number") return String(random.int(0, 99_999));
  return randomText(random);
}

/** Model-free generator choice by input type, for the heuristic baseline. */
export function heuristicGenerator(inputType: string, name: string): string {
  if (inputType === "email" || /e-?mail/iu.test(name))
    return "faker.internet.exampleEmail";
  if (inputType === "tel") return "faker.phone.number";
  if (inputType === "number") return "faker.number.int";
  if (/zip|postal|postcode/iu.test(name)) return "faker.location.zipCode";
  if (/name/iu.test(name)) return "faker.person.fullName";
  return "faker.lorem.words";
}
