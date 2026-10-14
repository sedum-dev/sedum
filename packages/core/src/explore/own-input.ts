import type { Detection } from "../detector/checks.js";

/**
 * Page text without the values the walk typed, for the exact-leak check:
 * the walk's own "test NaN value" is not a value the app failed to fill.
 */
export function withoutOwnInput(text: string, typed: Iterable<string>): string {
  let rest = text;
  for (const value of [...typed].sort((a, b) => b.length - a.length))
    rest = rest.replaceAll(value, " ");
  return rest;
}

/**
 * Jev's broken-value answer judges the whole page, so it cannot tell the
 * walk's lorem ipsum or "test … value" strings from a broken value: on a
 * page that shows them back, only an exact leak outside them still counts.
 */
export function trustedDetections(
  detections: readonly Detection[],
  showsOwnInput: boolean,
): Detection[] {
  return detections.filter(
    (d) =>
      !(showsOwnInput && d.check === "broken_value" && d.source === "model"),
  );
}
