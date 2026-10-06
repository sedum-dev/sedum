import path from "node:path";
import { affectedPathIgnored, validAffectedGlob } from "./affected-paths.js";
import {
  AffectedSelectionError,
  gitRead,
  MAX_DIFF_BYTES,
} from "./affected-git-read.js";
export { AffectedSelectionError } from "./affected-git-read.js";

type GitSnapshot = {
  readonly root: string;
  readonly head: string;
  readonly signal?: AbortSignal | undefined;
};

export async function assertAffectedSnapshot({
  root,
  head,
  signal,
}: GitSnapshot): Promise<void> {
  signal?.throwIfAborted();
  await assertVisibleIndex({ root, head, signal });
  const status = await gitRead(
    root,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=none",
    ],
    signal,
  );
  if (status)
    throw new AffectedSelectionError(
      "Tracked staged or unstaged changes (including dirty submodules) are not allowed with --affected, even on ignored paths. Commit or stash them first; no sources were sent.",
    );
  if ((await gitRead(root, ["rev-parse", "HEAD"], signal)).trim() !== head)
    throw new AffectedSelectionError(
      "HEAD changed during affected selection. Retry from a clean checkout.",
    );
}

/** Status cannot establish cleanliness when index flags hide working-tree edits. */
async function assertVisibleIndex({
  root,
  signal,
}: GitSnapshot): Promise<void> {
  const entries = (
    await gitRead(
      root,
      ["ls-files", "-v", "-z", "--full-name", "--", ":/"],
      signal,
    )
  ).split("\0");
  if (entries.some((entry) => /^[a-zS] /u.test(entry)))
    throw new AffectedSelectionError(
      "Tracked files with assume-unchanged or skip-worktree flags are not supported with --affected, even on ignored paths. Clear those index flags or run without --affected; no sources were sent.",
    );
}

export async function readCommittedSource(
  { root, head, signal }: GitSnapshot,
  file: string,
): Promise<string> {
  const relative = repositoryRelativePath(root, file);
  try {
    return await gitRead(root, ["show", `${head}:${relative}`], signal);
  } catch (error) {
    rethrowGitError(
      error,
      signal,
      "A test or module is not readable at pinned HEAD. Commit test sources before using --affected.",
    );
  }
}

/** Preserve actionable/cancellation errors; replace Git details with safe guidance. */
function rethrowGitError(
  error: unknown,
  signal: AbortSignal | undefined,
  message: string,
): never {
  if (error instanceof AffectedSelectionError) throw error;
  signal?.throwIfAborted();
  throw new AffectedSelectionError(message);
}

function repositoryRelativePath(root: string, file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (relative.startsWith("../") || path.isAbsolute(relative))
    throw new AffectedSelectionError(
      "A test or module is outside the Git repository.",
    );
  return relative;
}

async function findBaseRef({ root, signal }: GitSnapshot): Promise<string> {
  for (const candidate of [
    "refs/heads/main",
    "refs/remotes/origin/main",
    "refs/heads/master",
    "refs/remotes/origin/master",
  ]) {
    try {
      await gitRead(
        root,
        ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`],
        signal,
      );
      return candidate;
    } catch {
      signal?.throwIfAborted();
    }
  }
  throw new AffectedSelectionError(
    "No main or master ref found. Fetch the base branch or pass --base <ref>.",
  );
}

async function resolveBranchRange(snapshot: GitSnapshot, base?: string) {
  const reference = base || (await findBaseRef(snapshot));
  const commit = (
    await gitRead(
      snapshot.root,
      ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`],
      snapshot.signal,
    )
  ).trim();
  const mergeBase = (
    await gitRead(
      snapshot.root,
      ["merge-base", commit, snapshot.head],
      snapshot.signal,
    )
  ).trim();
  return { reference, mergeBase };
}

async function assertUntrackedIgnored(
  { root, signal }: GitSnapshot,
  ignore: readonly string[],
): Promise<void> {
  const untracked = (
    await gitRead(
      root,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--full-name",
        "-z",
        "--",
        ":/",
      ],
      signal,
    )
  )
    .split("\0")
    .filter(Boolean);
  if (untracked.some((file) => !affectedPathIgnored(file, ignore)))
    throw new AffectedSelectionError(
      "Untracked files are not represented in committed git diff. Commit intended files or ignore unrelated files before using --affected.",
    );
}

const DIFF_ARGS = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-renames",
  "--no-relative",
  "--ignore-submodules=none",
];

async function readRetainedPatches(
  { root, head, signal }: GitSnapshot,
  mergeBase: string,
  files: readonly string[],
): Promise<string> {
  const patches: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const patch = await gitRead(
      root,
      [
        ...DIFF_ARGS,
        "--no-color",
        "--submodule=short",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--unified=3",
        mergeBase,
        head,
        "--",
        `:(top,literal)${file}`,
      ],
      signal,
      MAX_DIFF_BYTES - bytes,
    );
    if (
      /^Binary files .* differ$/mu.test(patch) ||
      /^[+ -]Subproject commit /mu.test(patch)
    )
      throw new AffectedSelectionError(
        "Binary or submodule changes cannot be scored reliably. Run the full suite without --affected.",
      );
    bytes += Buffer.byteLength(patch);
    patches.push(patch);
  }
  return patches.join("");
}

function assertValidIgnores(ignore: readonly string[]): void {
  if (ignore.some((pattern) => !validAffectedGlob(pattern)))
    throw new AffectedSelectionError(
      "Affected ignores must be valid nonempty repository-relative POSIX globs.",
    );
}

export async function readBranchDiff(
  cwd: string,
  base?: string,
  signal?: AbortSignal,
  ignore: readonly string[] = [],
) {
  assertValidIgnores(ignore);
  const git = (...args: string[]) => gitRead(cwd, args, signal);
  try {
    const root = (await git("rev-parse", "--show-toplevel")).trim();
    const head = (await git("rev-parse", "--verify", "HEAD^{commit}")).trim();
    const snapshot = { root, head, signal };
    await assertAffectedSnapshot(snapshot);
    const { reference, mergeBase } = await resolveBranchRange(snapshot, base);
    await assertUntrackedIgnored(snapshot, ignore);
    const changed = (
      await git(...DIFF_ARGS, "--name-only", "-z", mergeBase, head, "--", ":/")
    )
      .split("\0")
      .filter(Boolean);
    const ignoredFiles = changed.filter((file) =>
      affectedPathIgnored(file, ignore),
    );
    const diff = await readRetainedPatches(
      snapshot,
      mergeBase,
      changed.filter((file) => !affectedPathIgnored(file, ignore)),
    );
    await assertAffectedSnapshot(snapshot);
    return {
      root,
      base: reference,
      head,
      mergeBase,
      diff,
      changed,
      ignoredFiles,
    };
  } catch (error) {
    rethrowGitError(
      error,
      signal,
      "Could not read a complete Git diff. Check the base ref and merge-base history (fetch deeper for shallow clones), or run without --affected.",
    );
  }
}
