import type { CacheEntry, CacheMissReason } from "./page-cache.js";

export type LocatorCacheLookup =
  | { readonly entry: CacheEntry; readonly reason?: never }
  | { readonly entry?: never; readonly reason: CacheMissReason };

/** Storage returns a recipe; only the locator can decide whether the live page is a hit. */
export interface CacheStore {
  /** The checkout-local HMAC key. It never crosses the browser or provider seam. */
  readonly key: Uint8Array | null;
  lookup(key: string): Promise<LocatorCacheLookup>;
  put(key: string, entry: CacheEntry): Promise<void>;
  invalidate(key: string, observed?: CacheEntry): Promise<void>;
  clear(): Promise<void>;
}

export class NoopCacheStore implements CacheStore {
  readonly key = null;

  constructor(
    readonly reason:
      | "disabled"
      | "ci_default"
      | "outside_git"
      | "corrupt"
      | "storage_error" = "disabled",
  ) {}

  async lookup(): Promise<LocatorCacheLookup> {
    return { reason: this.reason };
  }

  async put(): Promise<void> {}
  async invalidate(): Promise<void> {}
  async clear(): Promise<void> {}
}
