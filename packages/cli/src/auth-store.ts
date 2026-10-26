import { constants, unlinkSync, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { AuthError, tokensSchema } from "./auth-api.js";

const stateSchema = z.object({
  selectedOrigin: z.string().optional(),
  selections: z.record(
    z.string(),
    z.object({
      organization: z.string().optional(),
      project: z.string().optional(),
    }),
  ),
  sessions: z.record(
    z.string(),
    tokensSchema.extend({ expiresAt: z.number().finite() }),
  ),
});
export type AuthState = z.infer<typeof stateSchema>;

function configRoot(directory: string | undefined): string {
  const platformRoot =
    process.platform === "win32"
      ? (process.env.APPDATA ?? homedir())
      : path.join(homedir(), ".config");
  return path.resolve(
    directory ??
      path.join(process.env.XDG_CONFIG_HOME ?? platformRoot, "sedum"),
  );
}
function ownerOnly(info: Stats): boolean {
  if (process.platform === "win32") return true;
  return (info.mode & 0o077) === 0 && info.uid === process.getuid?.();
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function rejectSymlink(file: string) {
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw new AuthError(
        "Unsafe credential directory: symbolic links are not allowed.",
      );
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
async function rejectCheckout(marker: URL) {
  try {
    await lstat(marker);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  throw new AuthError(
    "Credential storage must be outside a Git checkout. Set XDG_CONFIG_HOME to an external user config directory.",
  );
}
async function prepareDirectory(root: string) {
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    await rejectSymlink(current);
    await rejectCheckout(pathToFileURL(path.join(current, ".git")));
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || !ownerOnly(info))
    throw new AuthError(
      "Credential directory must be owned by you with mode 0700.",
    );
}
const lockedMessage =
  "Authentication store is locked. Wait for other auth commands; if none are running, remove auth.lock (and auth.lock.break, if present) from your Sedum user config directory.";
const lockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
});
// Locks this process holds. A crash skips the async unlock, so release them
// synchronously on exit; only SIGKILL or power loss can leave one behind.
const heldLocks = new Set<string>();
process.on("exit", () => {
  for (const file of heldLocks) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
});
// Publish a lock file that already names its owner, so no reader sees it
// empty. Resolve to its release, or undefined when another owner holds it.
async function acquireLock(
  file: string,
): Promise<(() => Promise<void>) | undefined> {
  const temporary = `${file}-${randomUUID()}`;
  await writeFile(
    temporary,
    JSON.stringify({ pid: process.pid, host: hostname() }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  } finally {
    await unlink(temporary);
  }
  heldLocks.add(file);
  return async () => {
    heldLocks.delete(file);
    await unlink(file);
  };
}
function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
async function ownerDied(file: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (missing(error)) return true;
    throw error;
  }
  let owner: unknown;
  try {
    owner = JSON.parse(content);
  } catch {
    return false;
  }
  const parsed = lockOwnerSchema.safeParse(owner);
  // Unknown owners (older CLIs write empty locks) and other hosts sharing this
  // directory cannot be checked, so they keep the lock.
  if (!parsed.success || parsed.data.host !== hostname()) return false;
  return !ownerAlive(parsed.data.pid);
}
// Breakers take auth.lock.break first, so one cannot delete a lock that
// another breaker has just created between its owner check and its unlink.
async function breakDeadLock(file: string): Promise<boolean> {
  const releaseGuard = await acquireLock(`${file}.break`);
  if (!releaseGuard) return false;
  try {
    if (!(await ownerDied(file))) return false;
    await unlink(file).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
    return true;
  } finally {
    await releaseGuard();
  }
}
async function lockStore(root: string) {
  const lockPath = path.join(root, "auth.lock");
  const release =
    (await acquireLock(lockPath)) ??
    ((await breakDeadLock(lockPath)) ? await acquireLock(lockPath) : undefined);
  if (!release) throw new AuthError(lockedMessage);
  return release;
}
function safeFile(info: Stats) {
  if (!info.isFile()) return false;
  if (info.nlink !== 1) return false;
  return ownerOnly(info);
}
async function readState(file: URL): Promise<AuthState> {
  try {
    const info = await lstat(file);
    if (!safeFile(info))
      throw new AuthError(
        "Unsafe credential file; require an owner-only regular file.",
      );
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      if (!safeFile(actual))
        throw new AuthError(
          "Unsafe credential file; require an owner-only regular file.",
        );
      return stateSchema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!missing(error)) throw error;
    return { selections: {}, sessions: {} };
  }
}
async function writeState(root: string, state: AuthState) {
  const temporary = path.join(root, `.auth-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
    await handle.close();
    await rename(temporary, path.join(root, "auth.json"));
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

// Hold one exclusive lock across network refresh and atomic rotation. Break a
// lock only when its owner is gone: a paused process could still own a
// refresh secret, so a live PID keeps the lock however old it is.
export async function withAuthStore<T>(
  directory: string | undefined,
  action: (state: AuthState, save: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const root = configRoot(directory);
  const unlock = await storageOperation(async () => {
    await prepareDirectory(root);
    return lockStore(root);
  });
  try {
    const state = await storageOperation(() =>
      readState(pathToFileURL(path.join(root, "auth.json"))),
    );
    return await action(state, () =>
      storageOperation(() => writeState(root, state)),
    );
  } finally {
    await storageOperation(unlock);
  }
}

async function storageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      "Cannot safely access authentication storage. Check your Sedum user config directory and its permissions.",
    );
  }
}
