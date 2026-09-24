import { createHash } from "node:crypto";

export interface ShardSpec {
  /** 1-based, as in Playwright's `--shard=current/total`. */
  readonly index: number;
  readonly count: number;
}

function hashKey(key: string): string {
  return createHash("sha1").update(key).digest("hex");
}

/**
 * Deterministic split used by Jest and Vitest: order by a hash of each stable
 * key, then take a contiguous, size-balanced slice. The result is independent
 * of discovery order, shard sizes differ by at most one, and adding one item
 * moves at most `count - 1` existing items between shards.
 */
export function shardItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  shard: ShardSpec,
): T[] {
  const { index, count } = shard;
  if (!Number.isSafeInteger(count) || count < 1)
    throw new RangeError("Shard count must be a positive integer");
  if (!Number.isSafeInteger(index) || index < 1 || index > count)
    throw new RangeError("Shard index must be between 1 and the shard count");
  const ordered = items
    .map((item) => ({ item, key: keyOf(item) }))
    .map((entry) => ({ ...entry, hash: hashKey(entry.key) }))
    .sort((a, b) =>
      a.hash < b.hash
        ? -1
        : a.hash > b.hash
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    );
  const start = Math.floor(((index - 1) * ordered.length) / count);
  const end = Math.floor((index * ordered.length) / count);
  return ordered.slice(start, end).map((entry) => entry.item);
}

/** Shard selected tests by their stable identity (explicit `id`, else path). */
export function shardTests<T extends { readonly id: string }>(
  tests: readonly T[],
  shard: ShardSpec,
): T[] {
  return shardItems(tests, (test) => test.id, shard);
}

/** Each discovery problem is owned by exactly one shard, keyed by its file. */
export function shardProblems<T extends { readonly file: string }>(
  problems: readonly T[],
  shard: ShardSpec,
): T[] {
  const files = [...new Set(problems.map((problem) => problem.file))];
  const owned = new Set(shardItems(files, (file) => file, shard));
  return problems.filter((problem) => owned.has(problem.file));
}
