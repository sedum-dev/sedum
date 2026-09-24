import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocatorCacheConflict,
  pageKey,
  type CacheEntry,
} from "@sedum-dev/core";
import {
  LocalLocatorCacheStore,
  clearLocatorCache,
  openLocatorCache,
} from "./locator-cache-store.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function checkout(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-locator-cache-"));
  temporary.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

function entry(key: string): CacheEntry {
  return {
    format: 1,
    matcher: 1,
    pageKey: key,
    tag: "button",
    role: "button",
    inputType: "",
    editable: false,
    disabled: false,
    path: "body>article>button",
    digests: { label: "a".repeat(64), peers: ["b".repeat(64)] },
  };
}

describe("local locator cache", () => {
  it("selects CI and outside-Git bypasses with explicit precedence", async () => {
    const root = await checkout();
    expect(await openLocatorCache(root, { env: { CI: "1" } })).toMatchObject({
      key: null,
      reason: "ci_default",
    });
    expect(
      await openLocatorCache(root, {
        disabled: true,
        ciOptIn: true,
        env: { CI: "1" },
      }),
    ).toMatchObject({ key: null, reason: "disabled" });
    expect(
      await openLocatorCache(root, { ciOptIn: true, env: { CI: "1" } }),
    ).toBeInstanceOf(LocalLocatorCacheStore);
    const outside = await mkdtemp(path.join(tmpdir(), "sedum-no-git-"));
    temporary.push(outside);
    expect(await openLocatorCache(outside, { env: {} })).toMatchObject({
      key: null,
      reason: "outside_git",
    });
  });

  it("keeps per-worktree, atomic, digest-only entries and clears key with data", async () => {
    const root = await checkout();
    const worktree = path.join(root, "linked");
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
    execFileSync("git", [
      "-C",
      root,
      "worktree",
      "add",
      "-q",
      "--detach",
      worktree,
    ]);
    const first = await openLocatorCache(root, { env: {} });
    const linked = await openLocatorCache(worktree, { env: {} });
    expect(first).toBeInstanceOf(LocalLocatorCacheStore);
    expect(linked).toBeInstanceOf(LocalLocatorCacheStore);
    const a = first as LocalLocatorCacheStore;
    const b = linked as LocalLocatorCacheStore;
    expect(a.directory).not.toBe(b.directory);
    expect(a.key).not.toEqual(b.key);
    const digest = pageKey(
      a.key,
      "https://example.test/private?q=secret",
      "click",
      "Buy Camera",
    );
    await a.put(digest, entry(digest));
    expect(await a.lookup(digest)).toMatchObject({
      entry: { pageKey: digest },
    });
    expect(await b.lookup(digest)).toEqual({ reason: "absent" });
    const cacheText = await readFile(
      path.join(a.directory, "entries", `${digest}.json`),
      "utf8",
    );
    expect(cacheText).not.toMatch(/secret|Camera|example\.test/u);
    if (process.platform !== "win32") {
      expect((await stat(a.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(a.directory, "key"))).mode & 0o777).toBe(
        0o600,
      );
      expect(
        (await stat(path.join(a.directory, "entries", `${digest}.json`))).mode &
          0o777,
      ).toBe(0o600);
    }
    expect(await clearLocatorCache(root)).toBe(true);
    const cold = await openLocatorCache(root, { env: {} });
    expect(cold.key).not.toEqual(a.key);
    expect(await cold.lookup(digest)).toEqual({ reason: "absent" });
    expect(await b.lookup(digest)).toEqual({ reason: "absent" });
  });

  it("fails closed on a corrupt entry or key and invalidates entries after key loss", async () => {
    const root = await checkout();
    const store = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const digest = pageKey(
      store.key,
      "https://example.test/",
      "click",
      "Buy Camera",
    );
    await store.put(digest, entry(digest));
    await writeFile(
      path.join(store.directory, "entries", `${digest}.json`),
      "{",
    );
    expect(await store.lookup(digest)).toEqual({ reason: "corrupt" });
    await unlink(path.join(store.directory, "key"));
    const rekeyed = await openLocatorCache(root, { env: {} });
    expect(rekeyed.key).not.toEqual(store.key);
    expect(await rekeyed.lookup(digest)).toEqual({ reason: "absent" });
    await expect(store.put(digest, entry(digest))).rejects.toThrow(
      "key changed",
    );
    await writeFile(
      path.join((rekeyed as LocalLocatorCacheStore).directory, "key"),
      "wrong key",
    );
    expect(await openLocatorCache(root, { env: {} })).toMatchObject({
      key: null,
      reason: "corrupt",
    });
  });

  it("serializes put and invalidate for the same key across store instances", async () => {
    const root = await checkout();
    const first = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const second = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const digest = pageKey(
      first.key,
      "https://example.test/",
      "click",
      "Buy Camera",
    );
    const lock = path.join(first.directory, "entries", `${digest}.json.lock`);
    await mkdir(lock);
    let putFinished = false;
    const pendingPut = first.put(digest, entry(digest)).then(() => {
      putFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(putFinished).toBe(false);
    await rmdir(lock);
    await pendingPut;
    expect(await second.lookup(digest)).toMatchObject({
      entry: { pageKey: digest },
    });
    await mkdir(lock);
    let invalidated = false;
    const pendingInvalidate = second
      .invalidate(digest, entry(digest))
      .then(() => {
        invalidated = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(invalidated).toBe(false);
    await rmdir(lock);
    await pendingInvalidate;
    expect(await first.lookup(digest)).toEqual({ reason: "absent" });
  });

  it("does not invalidate a newer successful recipe after an old lookup", async () => {
    const root = await checkout();
    const first = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const second = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const digest = pageKey(
      first.key,
      "https://example.test/",
      "click",
      "Buy Camera",
    );
    const old = entry(digest);
    const newer: CacheEntry = {
      ...old,
      digests: { ...old.digests, id: "c".repeat(64) },
    };
    await first.put(digest, old);
    expect(await first.lookup(digest)).toMatchObject({ entry: old });
    await second.put(digest, newer);
    await first.invalidate(digest, old);
    expect(await first.lookup(digest)).toMatchObject({ entry: newer });
    await second.invalidate(digest, newer);
    expect(await first.lookup(digest)).toEqual({ reason: "absent" });
  });

  it("breaks a stale lock left by a crashed writer", async () => {
    const root = await checkout();
    const store = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const digest = pageKey(
      store.key,
      "https://example.test/",
      "click",
      "Buy Camera",
    );
    const lock = path.join(store.directory, "entries", `${digest}.json.lock`);
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await store.put(digest, entry(digest));
    expect(await store.lookup(digest)).toMatchObject({
      entry: { pageKey: digest },
    });
    await expect(stat(lock)).rejects.toThrow();
  });

  it("reports a live lock held too long as a typed conflict, not corruption", async () => {
    const root = await checkout();
    const store = (await openLocatorCache(root, {
      env: {},
    })) as LocalLocatorCacheStore;
    const digest = pageKey(
      store.key,
      "https://example.test/",
      "click",
      "Buy Camera",
    );
    await store.put(digest, entry(digest));
    const lock = path.join(store.directory, "entries", `${digest}.json.lock`);
    await mkdir(lock);
    await expect(store.put(digest, entry(digest))).rejects.toBeInstanceOf(
      LocatorCacheConflict,
    );
    expect(await store.lookup(digest)).toMatchObject({
      entry: { pageKey: digest },
    });
    await rmdir(lock);
  });

  it("keeps entries valid under concurrent writers from parallel lanes", async () => {
    const root = await checkout();
    const stores = (await Promise.all(
      Array.from({ length: 4 }, () => openLocatorCache(root, { env: {} })),
    )) as LocalLocatorCacheStore[];
    const digest = pageKey(
      stores[0]!.key,
      "https://example.test/",
      "click",
      "Buy Camera",
    );
    const variants = stores.map((_, index): CacheEntry => ({
      ...entry(digest),
      path: `body>article>button:nth-of-type(${index + 1})`,
    }));
    const outcomes = await Promise.allSettled(
      stores.flatMap((store, index) => [
        store.put(digest, variants[index]!),
        store.invalidate(digest, variants[(index + 1) % variants.length]!),
        store.put(digest, variants[index]!),
      ]),
    );
    for (const outcome of outcomes)
      if (outcome.status === "rejected")
        expect(outcome.reason).toBeInstanceOf(LocatorCacheConflict);
    const final = await stores[0]!.lookup(digest);
    if ("entry" in final && final.entry)
      expect(variants).toContainEqual(final.entry);
    else expect(final).toEqual({ reason: "absent" });
  });
});
