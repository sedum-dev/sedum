import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * The directories CI tools resolve JUnit `[[ATTACHMENT|path]]` lines against:
 * GitLab's project directory, the Jenkins workspace, the GitHub workspace.
 */
const CI_ROOTS = ["CI_PROJECT_DIR", "WORKSPACE", "GITHUB_WORKSPACE"] as const;

async function relativeInside(
  base: string,
  target: string,
): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(base);
  } catch {
    return null;
  }
  const relative = path.relative(real, target);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  return relative.split(path.sep).join("/");
}

/**
 * Where a run's evidence frames are, as JUnit attachments should name them.
 * In a monorepo the Sedum project can sit below the CI checkout, so the path
 * is relative to the first CI root that contains the run, else to the project
 * root. Only a path prefix is derived from the environment; its value never
 * reaches the report. Null when no usable relative path exists.
 */
export async function junitEvidenceDirectory(
  runDirectory: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  let run: string;
  try {
    run = await realpath(runDirectory);
  } catch {
    return null;
  }
  for (const name of CI_ROOTS) {
    const value = env[name];
    if (!value || !path.isAbsolute(value)) continue;
    const relative = await relativeInside(value, run);
    if (relative) return usable(relative);
  }
  const relative = await relativeInside(projectRoot, run);
  return relative ? usable(relative) : null;
}

/** Brackets and pipes would break the attachment marker; list none then. */
function usable(relative: string): string | null {
  const unsafe = [...relative].some(
    (char) => "[]|".includes(char) || char.charCodeAt(0) < 0x20,
  );
  return unsafe ? null : relative;
}
