import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  NoopCacheStore,
  type CacheEntry,
  type CacheStore,
  type LocatorCacheLookup,
} from "@sedum-dev/core";

const run = promisify(execFile);
const HASH = /^[a-f0-9]{64}$/u;
const MAX_ENTRY_BYTES = 16 * 1024;
const KEY_FILE = "key";
const ENTRY_DIR = "entries";

export interface LocatorCachePolicy {
  readonly disabled?: boolean;
  readonly ciOptIn?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  return !!env.CI && env.CI !== "false" && env.CI !== "0";
}

async function gitCachePath(root: string): Promise<string | null> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  try {
    const inside = await run(
      "git",
      ["-C", root, "rev-parse", "--is-inside-work-tree"],
      {
        env,
      },
    );
    if (inside.stdout.trim() !== "true") return null;
    const metadata = await run(
      "git",
      [
        "-C",
        root,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "sedum/locator-cache",
      ],
      { env },
    );
    const resolved = metadata.stdout.trim();
    return path.isAbsolute(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

async function regularFile(filename: string): Promise<boolean> {
  try {
    return (await fs.lstat(filename)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(filename: string, content: string): Promise<void> {
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temp, filename);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

export class LocalLocatorCacheStore implements CacheStore {
  private constructor(
    readonly directory: string,
    readonly key: Uint8Array,
  ) {}

  static async open(directory: string): Promise<LocalLocatorCacheStore> {
    const parent = path.dirname(directory);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(parent)).isDirectory())
      throw new Error("Invalid locator cache parent directory");
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    if (!(await fs.lstat(directory)).isDirectory())
      throw new Error("Invalid locator cache directory");
    await fs.chmod(directory, 0o700);
    const entries = path.join(directory, ENTRY_DIR);
    await fs.mkdir(entries, { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    if (!(await fs.lstat(entries)).isDirectory())
      throw new Error("Invalid locator entry directory");
    await fs.chmod(entries, 0o700);
    const keyPath = path.join(directory, KEY_FILE);
    const lock = path.join(directory, ".init-lock");
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw new Error("Locator cache initialization timed out");
    let key: Uint8Array;
    try {
      if (await regularFile(keyPath)) {
        key = new Uint8Array(await fs.readFile(keyPath));
        if (key.byteLength !== 32) throw new Error("Invalid locator cache key");
        await fs.chmod(keyPath, 0o600);
      } else {
        const generated = randomBytes(32);
        await fs.writeFile(keyPath, generated, { flag: "wx", mode: 0o600 });
        // Without the old key, no existing entry can be trusted.
        for (const name of await fs.readdir(entries))
          await fs.rm(path.join(entries, name), { force: true });
        key = generated;
      }
    } finally {
      await fs.rmdir(lock);
    }
    return new LocalLocatorCacheStore(directory, key);
  }

  private filename(key: string): string {
    if (!HASH.test(key))
      throw new RangeError("Invalid locator cache key digest");
    return path.join(this.directory, ENTRY_DIR, `${key}.json`);
  }

  private async currentKey(): Promise<boolean> {
    const filename = path.join(this.directory, KEY_FILE);
    if (!(await regularFile(filename))) return false;
    const current = await fs.readFile(filename);
    return current.byteLength === 32 && Buffer.from(this.key).equals(current);
  }

  private async withEntryLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lock = `${this.filename(key)}.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fs.mkdir(lock, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw new Error("Locator cache entry lock timed out");
    try {
      return await operation();
    } finally {
      await fs.rmdir(lock);
    }
  }

  async lookup(key: string): Promise<LocatorCacheLookup> {
    try {
      if (!(await this.currentKey())) return { reason: "corrupt" };
      const filename = this.filename(key);
      if (!(await regularFile(filename))) return { reason: "absent" };
      const stat = await fs.stat(filename);
      if (stat.size > MAX_ENTRY_BYTES) return { reason: "corrupt" };
      const value = JSON.parse(await fs.readFile(filename, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value))
        return { reason: "corrupt" };
      return { entry: value as CacheEntry };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { reason: "absent" };
      if (error instanceof SyntaxError) return { reason: "corrupt" };
      return { reason: "storage_error" };
    }
  }

  async put(key: string, entry: CacheEntry): Promise<void> {
    await this.withEntryLock(key, async () => {
      if (!(await this.currentKey()))
        throw new Error("Locator cache key changed");
      if (entry.pageKey !== key) throw new Error("Locator entry key mismatch");
      const content = JSON.stringify(entry);
      if (Buffer.byteLength(content) > MAX_ENTRY_BYTES)
        throw new Error("Locator entry too large");
      await atomicWrite(this.filename(key), content);
    });
  }

  async invalidate(key: string, observed?: CacheEntry): Promise<void> {
    await this.withEntryLock(key, async () => {
      if (!(await this.currentKey())) return;
      const filename = this.filename(key);
      if (!(await regularFile(filename))) return;
      const stat = await fs.stat(filename);
      if (stat.size > MAX_ENTRY_BYTES) {
        if (!observed) await fs.rm(filename, { force: true });
        return;
      }
      let current: unknown;
      try {
        current = JSON.parse(await fs.readFile(filename, "utf8")) as unknown;
      } catch (error) {
        if (error instanceof SyntaxError && !observed)
          await fs.rm(filename, { force: true });
        else if (!(error instanceof SyntaxError)) throw error;
        return;
      }
      if (observed) {
        if (JSON.stringify(current) === JSON.stringify(observed))
          await fs.rm(filename, { force: true });
      } else if (
        !current ||
        typeof current !== "object" ||
        Array.isArray(current)
      )
        await fs.rm(filename, { force: true });
    });
  }

  async clear(): Promise<void> {
    await fs.rm(this.directory, { recursive: true, force: true });
  }
}

export async function openLocatorCache(
  root: string,
  policy: LocatorCachePolicy = {},
): Promise<CacheStore> {
  if (policy.disabled) return new NoopCacheStore("disabled");
  const env = policy.env ?? process.env;
  if (isCi(env) && !policy.ciOptIn && env.SEDUM_LOCATOR_CACHE_CI !== "1")
    return new NoopCacheStore("ci_default");
  const directory = await gitCachePath(root);
  if (!directory) return new NoopCacheStore("outside_git");
  try {
    return await LocalLocatorCacheStore.open(directory);
  } catch (error) {
    return new NoopCacheStore(
      error instanceof Error && error.message === "Invalid locator cache key"
        ? "corrupt"
        : "storage_error",
    );
  }
}

export async function clearLocatorCache(root: string): Promise<boolean> {
  const directory = await gitCachePath(root);
  if (!directory) return false;
  try {
    if (!(await fs.lstat(path.dirname(directory))).isDirectory())
      throw new Error("Invalid locator cache parent directory");
    if (!(await fs.lstat(directory)).isDirectory())
      throw new Error("Invalid locator cache directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fs.rm(directory, { recursive: true, force: true });
  return true;
}
