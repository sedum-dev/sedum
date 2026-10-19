import { setTimeout as delay } from "node:timers/promises";
import { parseRetryAfter } from "@sedum-dev/core";
import { z } from "zod";
import { gitRead } from "./affected-git-read.js";
import { readProjectEnvironment } from "./config.js";
import type { RunCommandExecution } from "./run-command.js";

type CloudUpload = (execution: RunCommandExecution) => Promise<string>;

interface UploadTarget {
  readonly url: URL;
  readonly projectId: string;
  readonly headers: Record<string, string>;
}

interface UploadRequest {
  readonly target: UploadTarget;
  readonly body: string;
  readonly runId: string;
}

const settingsSchema = z.object({
  SEDUM_CLOUD_URL: z
    .string()
    .transform((value) => cloudBaseUrl(new URL(value))),
  SEDUM_PROJECT_ID: z.uuid().transform((value) => value.toLowerCase()),
  SEDUM_UPLOAD_TOKEN: z.string().regex(/^sdu_[a-z0-9_-]{43}$/iu),
});

const sourceSchema = z.object({
  branch: z.string().trim().min(1).max(512),
  sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  url: z
    .url({ protocol: /^https$/u })
    .max(2048)
    .transform((value) => new URL(value))
    .refine((url) => ![url.username, url.password].some(Boolean))
    .optional()
    .catch(undefined),
});

/** Pin destination, credentials and source context before executing any tests. */
export async function prepareCloudUpload(
  cwd: string,
): Promise<CloudUpload | undefined> {
  try {
    const env = { ...(await readProjectEnvironment(cwd)), ...process.env };
    const values = [
      env.SEDUM_CLOUD_URL,
      env.SEDUM_PROJECT_ID,
      env.SEDUM_UPLOAD_TOKEN,
    ];
    if (!values.some(Boolean)) return undefined;
    const target = await uploadTarget(cwd, env);
    return (execution) => uploadReport(target, execution);
  } catch {
    // Neither dotenv parser errors nor URL/Git errors may disclose secrets.
    return async () =>
      "Cloud upload skipped: check SEDUM_CLOUD_URL, SEDUM_PROJECT_ID, SEDUM_UPLOAD_TOKEN and Git context (SEDUM_BRANCH / SEDUM_COMMIT_SHA). Local reporting is unchanged.\n";
  }
}

async function uploadTarget(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<UploadTarget> {
  const {
    SEDUM_CLOUD_URL: url,
    SEDUM_PROJECT_ID: projectId,
    SEDUM_UPLOAD_TOKEN: token,
  } = settingsSchema.parse(env);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/api/projects/${projectId}/runs`;
  return {
    url,
    projectId,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(await sourceHeaders(cwd, env)),
    },
  };
}

function cloudBaseUrl(url: URL): URL {
  if ([url.username, url.password, url.search, url.hash].some(Boolean))
    throw new Error("Invalid Cloud URL");
  if (url.protocol === "https:") return url;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && loopback) return url;
  throw new Error("Cloud requires HTTPS or loopback HTTP");
}

function ciContext(env: Readonly<Record<string, string | undefined>>) {
  if (env.GITHUB_ACTIONS === "true") {
    const branchRef = env.GITHUB_REF?.startsWith("refs/heads/")
      ? env.GITHUB_REF.slice(11)
      : undefined;
    return {
      branch: env.GITHUB_HEAD_REF || branchRef,
      sha: env.GITHUB_SHA,
      url: githubRunUrl(env),
    };
  }
  if (env.GITLAB_CI === "true")
    return {
      branch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_BRANCH,
      sha: env.CI_COMMIT_SHA,
      url: env.CI_JOB_URL || undefined,
    };
  return { branch: undefined, sha: undefined, url: undefined };
}

function githubRunUrl(env: Readonly<Record<string, string | undefined>>) {
  if (
    ![env.GITHUB_SERVER_URL, env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID].every(
      Boolean,
    )
  )
    return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

async function gitValue(
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const value = (
      await gitRead(
        cwd,
        ["rev-parse", ...args],
        AbortSignal.timeout(1_000),
        1_024,
      )
    ).trim();
    return value === "HEAD" ? undefined : value;
  } catch {
    return undefined;
  }
}

async function sourceHeaders(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<Record<string, string>> {
  const [gitBranch, gitSha] = await Promise.all([
    env.SEDUM_BRANCH ? undefined : gitValue(cwd, ["--abbrev-ref", "HEAD"]),
    env.SEDUM_COMMIT_SHA ? undefined : gitValue(cwd, ["HEAD"]),
  ]);
  const ci = ciContext(env);
  const source = sourceSchema.parse({
    branch: env.SEDUM_BRANCH || ci.branch || gitBranch,
    sha: env.SEDUM_COMMIT_SHA || gitSha || ci.sha,
    url: ci.url,
  });
  const headers: Record<string, string> = {
    // Fetch takes ByteString header values; Cloud reads the raw UTF-8 bytes.
    "x-sedum-branch": Buffer.from(source.branch, "utf8").toString("latin1"),
    "x-sedum-commit-sha": source.sha,
    ...(source.url ? { "x-sedum-ci-url": source.url.href } : {}),
  };
  // Validate header encodings before the run, not in the retry loop.
  new Headers(headers);
  return headers;
}

async function uploadReport(
  target: UploadTarget,
  execution: RunCommandExecution,
): Promise<string> {
  const warning = (reason: string) =>
    `Cloud upload warning: ${reason}. Local report: ${execution.artifacts.resultPath}\n`;
  if (
    !execution.artifacts.authoritative ||
    execution.result.state === "running"
  )
    return warning(
      "no authoritative terminal report was saved; nothing uploaded",
    );
  // One body for all attempts: Cloud ingestion is immutable and idempotent.
  const body = JSON.stringify(execution.result);
  if (Buffer.byteLength(body) > 8_000_000)
    return warning("report exceeds Cloud's 8 MB limit; nothing uploaded");
  const outcome = await deliverReport({
    target,
    body,
    runId: execution.result.runId,
  });
  return outcome.accepted
    ? `Cloud upload: accepted run ${execution.result.runId}.\n`
    : warning(outcome.reason);
}

async function deliverReport(request: UploadRequest) {
  // Independent of the run signal so interrupted runs can still be delivered.
  // The total budget includes response bodies, retries and backoff.
  const signal = AbortSignal.timeout(5_000);
  let reason = "delivery failed after retries";
  for (let attempt = 0; attempt < 3; attempt++) {
    let wait = 250 * 2 ** attempt;
    try {
      const outcome = await sendReport(request, signal);
      if (outcome.retryAfter === null) return outcome;
      reason = outcome.reason;
      wait = outcome.retryAfter ?? wait;
    } catch {
      // Fetch errors and response bodies can contain credentials or report data.
    }
    if (attempt < 2) {
      try {
        await delay(Math.min(wait, 5_000), undefined, { signal });
      } catch {
        break;
      }
    }
  }
  return {
    accepted: false,
    reason: signal.aborted ? "delivery exceeded the 5 second budget" : reason,
  };
}

async function sendReport(request: UploadRequest, signal: AbortSignal) {
  const response = await fetch(request.target.url, {
    method: "POST",
    headers: request.target.headers,
    body: request.body,
    signal,
    redirect: "manual",
  });
  if (response.ok) {
    const receipt: unknown = await response.json();
    return {
      accepted: z
        .object({
          id: z.string().min(1),
          status: z.literal("accepted"),
          project_id: z.literal(request.target.projectId),
          run_id: z.literal(request.runId),
        })
        .safeParse(receipt).success,
      reason: "Cloud returned an invalid upload receipt",
      retryAfter: null,
    };
  }
  const retryable =
    [408, 429].includes(response.status) || response.status >= 500;
  const wait = parseRetryAfter(response.headers, Date.now());
  await response.body?.cancel();
  return {
    accepted: false,
    reason: `HTTP ${response.status}`,
    // null stops delivery; undefined uses this attempt's exponential backoff.
    retryAfter: retryable ? (wait ?? undefined) : null,
  };
}
