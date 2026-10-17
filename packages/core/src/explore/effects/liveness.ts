import type { BrowserPage } from "../../browser-driver.js";
import type { Candidate } from "../../page-protocol.js";

/**
 * Click targets that cannot take a click: disabled (natively, by
 * `aria-disabled`, or by `pointer-events: none`), or covered at every probe
 * point by an unrelated element that is not a fixed or sticky bar (the
 * click scrolls past those).
 */
const DEAD_PATHS = String.raw`((paths) => {
  const PROBES = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
  const pinned = (n) => ["fixed", "sticky"].includes(getComputedStyle(n).position);
  const fixed = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) if (pinned(n)) return true; return false; };
  const related = (e, top) => top === e || e.contains(top) || top.contains(e);
  const blocks = (e, top) => !!top && !related(e, top) && !fixed(top);
  const onScreen = (b) => b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight;
  const measurable = (b) => b.width >= 2 && b.height >= 2 && onScreen(b);
  const probe = (b, [fx, fy]) => document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
  const covered = (e) => { const b = e.getBoundingClientRect(); return measurable(b) && PROBES.every((p) => blocks(e, probe(b, p))); };
  const disabled = (e) => !!e.closest(":disabled, [aria-disabled='true']") || getComputedStyle(e).pointerEvents === "none";
  // The scanner's element path: tag and index among same-tag siblings, 12 levels up.
  const step = (n) => n.tagName.toLowerCase() + ":" + (n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName).indexOf(n) : 0);
  const pathOf = (e) => { const steps = []; for (let n = e; n && steps.length < 12; n = n.parentElement) steps.unshift(step(n)); return steps.join("/"); };
  const tags = [...new Set(paths.map((p) => p.split("/").pop().split(":")[0]))].filter((t) => /^[a-z][a-z0-9-]*$/.test(t));
  const byPath = new Map();
  if (tags.length) for (const e of document.querySelectorAll(tags.join(","))) byPath.set(pathOf(e), e);
  return paths.filter((p) => { const e = byPath.get(p); return !!e && (disabled(e) || covered(e)); });
})`;

/**
 * The candidates that cannot take a click now. They are found by the
 * scanner's element path: their refs are gone once the fields were scanned.
 */
export async function deadTargets(
  page: BrowserPage,
  candidates: readonly Candidate[],
): Promise<Set<Candidate>> {
  if (!candidates.length) return new Set();
  const paths = JSON.stringify(candidates.map((c) => c.signals.path));
  const dead = new Set(
    await page
      .evaluate<string[]>(`${DEAD_PATHS}(${paths})`)
      .catch(() => [] as string[]),
  );
  return new Set(candidates.filter((c) => dead.has(c.signals.path)));
}

/** Clicks that changed nothing this often make a control dead in its state. */
export const DEAD_AFTER = 2;

/** Controls that, in a given state, were clicked and changed nothing. */
export class DeadControls {
  readonly #idle = new Map<string, number>();

  /** A click on `control` in `state` changed nothing; true once it is dead. */
  idle(state: string, control: string): boolean {
    const key = `${state}>${control}`;
    const count = (this.#idle.get(key) ?? 0) + 1;
    this.#idle.set(key, count);
    return count >= DEAD_AFTER;
  }

  dead(state: string, control: string): boolean {
    return (this.#idle.get(`${state}>${control}`) ?? 0) >= DEAD_AFTER;
  }
}
