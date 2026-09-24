export type ParallelRequest = number | "auto";

export const MAX_PARALLEL = 64;

/**
 * Lane count for a run. `auto` follows Playwright Test's default of half the
 * logical cores. Never more lanes than tests, and always at least one.
 */
export function planLanes(
  requested: ParallelRequest,
  availableParallelism: number,
  selectedTests: number,
): number {
  const wanted =
    requested === "auto"
      ? Math.max(1, Math.floor(availableParallelism / 2))
      : requested;
  return Math.max(1, Math.min(wanted, MAX_PARALLEL, selectedTests));
}

/** Parse `--parallel <n|auto>`; returns null for an invalid value. */
export function parseParallel(value: string): ParallelRequest | null {
  if (value === "auto") return "auto";
  if (!/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed <= MAX_PARALLEL ? parsed : null;
}

export interface PoolOptions<T> {
  readonly items: readonly T[];
  readonly lanes: number;
  /** Aborting stops scheduling; in-flight work observes the same signal. */
  readonly signal?: AbortSignal;
  /** Run one item on a lane. Returning `"stop"` stops scheduling new items. */
  readonly run: (
    item: T,
    lane: number,
    ordinal: number,
  ) => Promise<"continue" | "stop">;
}

/**
 * A fixed set of lanes pulling the next item from one shared cursor, so each
 * lane runs one item at a time and keeps a stable zero-based index (Playwright's
 * `parallelIndex`). A stop request halts scheduling; in-flight items finish.
 * The first thrown error also stops scheduling and is rethrown once every lane
 * has settled.
 */
export async function runPool<T>(options: PoolOptions<T>): Promise<void> {
  let cursor = 0;
  let stopped = false;
  let failure: { error: unknown } | null = null;
  const lane = async (index: number): Promise<void> => {
    while (!stopped && !options.signal?.aborted) {
      const ordinal = cursor++;
      if (ordinal >= options.items.length) return;
      try {
        if (
          (await options.run(options.items[ordinal]!, index, ordinal)) ===
          "stop"
        )
          stopped = true;
      } catch (error) {
        stopped = true;
        failure ??= { error };
      }
    }
  };
  const count = Math.max(1, Math.min(options.lanes, options.items.length));
  await Promise.all(Array.from({ length: count }, (_, index) => lane(index)));
  if (failure) throw (failure as { error: unknown }).error;
}
