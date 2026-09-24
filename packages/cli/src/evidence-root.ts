import { realpath } from "node:fs/promises";
import path from "node:path";
import { isEvidenceDirectory } from "@sedum-dev/reporters";

/**
 * The directories CI tools resolve JUnit `[[ATTACHMENT|path]]` lines against:
 * GitLab's project directory, the Jenkins workspace, the GitHub workspace.
 * Each counts only when its CI says it is running, because a name such as
 * WORKSPACE is common elsewhere and could point at `/` or a home directory,
 * which would put local directory names into the report.
 */
const CI_ROOTS: readonly {
  readonly root: string;
  readonly running: (env: NodeJS.ProcessEnv) => boolean;
}[] = [
  { root: "CI_PROJECT_DIR", running: (env) => env.GITLAB_CI === "true" },
  { root: "WORKSPACE", running: (env) => Boolean(env.JENKINS_URL) },
  {
    root: "GITHUB_WORKSPACE",
    running: (env) => env.GITHUB_ACTIONS === "true",
  },
];

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
 * is relative to the first running CI's root that contains the run, else to
 * the project root. Only a path prefix is derived from the environment; its
 * value never reaches the report. Null when no usable relative path exists,
 * so the report lists no attachments rather than failing to render.
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
  for (const { root, running } of CI_ROOTS) {
    const value = env[root];
    if (!value || !path.isAbsolute(value) || !running(env)) continue;
    const relative = await relativeInside(value, run);
    if (relative) return isEvidenceDirectory(relative) ? relative : null;
  }
  const relative = await relativeInside(projectRoot, run);
  return relative && isEvidenceDirectory(relative) ? relative : null;
}
