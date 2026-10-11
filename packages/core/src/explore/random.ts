/** A small seeded PRNG (mulberry32), so `--seed` reproduces a walk. */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0)
      throw new RangeError("Seed must be a nonnegative safe integer");
    this.#state = seed >>> 0 || 0x9e3779b9;
  }

  /** A float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (!items.length) throw new RangeError("Cannot pick from nothing");
    return items[this.int(0, items.length - 1)]!;
  }

  /** A child seed for an independent stream, such as Faker's. */
  fork(): number {
    return Math.floor(this.next() * 0x7fffffff);
  }
}

/** Pick an index with probability proportional to its weight. */
export function pickWeighted(
  random: SeededRandom,
  weights: readonly number[],
): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) throw new RangeError("Total weight must be positive");
  let roll = random.next() * total;
  for (const [index, weight] of weights.entries()) {
    if (roll < weight) return index;
    roll -= weight;
  }
  return weights.length - 1;
}

/** Scale weights to sum to one; an all-zero list stays zero. */
export function normalize(weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? weights.map((weight) => weight / total) : [...weights];
}

/** FNV-1a, for compact, stable state identities in traces. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
