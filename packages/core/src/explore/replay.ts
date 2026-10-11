import type { BrowserPage } from "../browser-driver.js";
import type { ResolvedStepTarget } from "../step-executor.js";
import { ActionDivergence, runAction } from "./actions.js";
import { settle } from "./observe.js";
import { Oracles } from "./oracles.js";
import type { ExploreAction, OracleEvent } from "./types.js";

export interface ReplayResult {
  readonly events: readonly OracleEvent[];
  /** Index of the first action with no matching target, if any. */
  readonly divergedAt?: number;
  /** URL after each action, aligned with the actions that ran. */
  readonly urls: readonly string[];
}

export interface ReplayHooks {
  /** Resolve a click or type target another way, such as by sentence. */
  readonly target?: (
    index: number,
    action: ExploreAction,
  ) => Promise<ResolvedStepTarget | undefined>;
}

/** Re-run recorded actions from the start URL on a fresh page. */
export async function replay(
  page: BrowserPage,
  startUrl: string,
  actions: readonly ExploreAction[],
  hooks: ReplayHooks = {},
): Promise<ReplayResult> {
  await page.goto(startUrl);
  await settle(page);
  const oracles = new Oracles(page, new URL(startUrl).origin);
  const events: OracleEvent[] = [];
  const urls: string[] = [];
  try {
    for (const [index, action] of actions.entries()) {
      try {
        await runAction(page, action, await hooks.target?.(index, action));
      } catch (error) {
        if (error instanceof ActionDivergence)
          return {
            events: [...events, ...oracles.drain()],
            divergedAt: index,
            urls,
          };
        await settle(page);
      }
      urls.push(page.url);
      events.push(...oracles.drain());
    }
    return { events, urls };
  } finally {
    oracles.detach();
  }
}

export interface FreshPage {
  readonly page: BrowserPage;
  close(): Promise<void>;
}

export interface ShrinkOptions {
  readonly startUrl: string;
  readonly actions: readonly ExploreAction[];
  readonly signature: string;
  /** A new, isolated page per replay, so state never leaks between tries. */
  readonly freshPage: () => Promise<FreshPage>;
  readonly maxReplays?: number;
}

export interface ShrinkResult {
  readonly actions: readonly ExploreAction[];
  readonly reproduced: boolean;
  readonly replays: number;
}

function without<T>(items: readonly T[], start: number, end: number): T[] {
  return [...items.slice(0, start), ...items.slice(end)];
}

type Check = (actions: readonly ExploreAction[]) => Promise<boolean>;

/** Remove the first chunk whose removal keeps the failure, if any. */
async function reduceOnce(
  current: readonly ExploreAction[],
  chunks: number,
  fails: Check,
  budgetLeft: () => boolean,
): Promise<ExploreAction[] | null> {
  const size = Math.ceil(current.length / chunks);
  for (let start = 0; start < current.length && budgetLeft(); start += size) {
    const candidate = without(current, start, start + size);
    if (candidate.length && (await fails(candidate))) return candidate;
  }
  return null;
}

/**
 * Delta debugging (ddmin, complements only) over a failing action list.
 * A candidate fails when replaying it shows the same failure signature; a
 * divergent replay counts as passing. Bombadil has no shrinking.
 */
export async function shrink(options: ShrinkOptions): Promise<ShrinkResult> {
  const maxReplays = options.maxReplays ?? 48;
  let replays = 0;
  const fails: Check = async (actions) => {
    replays++;
    const fresh = await options.freshPage();
    try {
      const result = await replay(fresh.page, options.startUrl, actions);
      return result.events.some((e) => e.signature === options.signature);
    } finally {
      await fresh.close();
    }
  };
  if (!(await fails(options.actions)))
    return { actions: options.actions, reproduced: false, replays };
  let current = [...options.actions];
  let chunks = 2;
  const budgetLeft = () => replays < maxReplays;
  while (current.length >= 2 && budgetLeft()) {
    const reduced = await reduceOnce(current, chunks, fails, budgetLeft);
    if (reduced) {
      current = reduced;
      chunks = Math.max(chunks - 1, 2);
    } else if (chunks >= current.length) break;
    else chunks = Math.min(current.length, chunks * 2);
  }
  return { actions: current, reproduced: true, replays };
}
