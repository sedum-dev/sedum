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

/** A configuration problem whose message names settings, never their values. */
class UploadSkipped extends Error {}

const settingsSchema = z.object({
  SEDUM_CLOUD_URL: z
    .string()
    .refine((value) => URL.canParse(value))
    .transform((value) => new URL(value))
    .refine(isCloudBaseUrl),
  SEDUM_PROJECT_ID: z.uuid().transform((value) => value.toLowerCase()),
  SEDUM_UPLOAD_TOKEN: z.string().regex(/^sdu_[a-z0-9_-]{43}$/iu),
});

const settingProblems: Record<string, string> = {
  SEDUM_CLOUD_URL:
    "SEDUM_CLOUD_URL must be an https:// base URL without credentials, query or fragment (http:// only for localhost)",
  SEDUM_PROJECT_ID: "SEDUM_PROJECT_ID must be the Cloud project UUID",
  SEDUM_UPLOAD_TOKEN:
    "SEDUM_UPLOAD_TOKEN must be the project's sdu_ upload credential",
};

const gitProblems: Record<string, string> = {
  branch:
    "no source branch detected (for example a detached checkout); set SEDUM_BRANCH",
  sha: "no commit detected; set SEDUM_COMMIT_SHA to the full lowercase commit hash",
};

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
  // Neither dotenv parser errors nor URL/Git errors may disclose secrets, so
  // warnings name the setting at fault, never its value or the raw error.
  const env = await readProjectEnvironment(cwd).then(
    (file) => ({ ...file, ...process.env }),
    () => undefined,
  );
  if (!env) return skipped("the project-root .env could not be read or parsed");
  const values = [
    env.SEDUM_CLOUD_URL,
    env.SEDUM_PROJECT_ID,
    env.SEDUM_UPLOAD_TOKEN,
  ];
  if (!values.some(Boolean)) return undefined;
  try {
    const target = await uploadTarget(cwd, env);
    return (execution) => uploadReport(target, execution);
  } catch (error) {
    return skipped(
      error instanceof UploadSkipped
        ? error.message
        : "the source branch cannot be sent as an HTTP header; set SEDUM_BRANCH",
    );
  }
}

function skipped(reason: string): CloudUpload {
  return async () =>
    `Cloud upload skipped: ${reason}. Local reporting is unchanged.\n`;
}

function parseOrSkip<T extends z.ZodType>(
  schema: T,
  value: unknown,
  messages: Record<string, string>,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const keys = new Set(
    parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  throw new UploadSkipped([...keys].map((key) => messages[key]).join("; "));
}

async function uploadTarget(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<UploadTarget> {
  const unset = Object.keys(settingProblems).filter((key) => !env[key]);
  if (unset.length) throw new UploadSkipped(`${unset.join(", ")} not set`);
  const {
    SEDUM_CLOUD_URL: url,
    SEDUM_PROJECT_ID: projectId,
    SEDUM_UPLOAD_TOKEN: token,
  } = parseOrSkip(settingsSchema, env, settingProblems);
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

function isCloudBaseUrl(url: URL): boolean {
  if ([url.username, url.password, url.search, url.hash].some(Boolean))
    return false;
  if (url.protocol === "https:") return true;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return url.protocol === "http:" && loopback;
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
  const source = parseOrSkip(
    sourceSchema,
    {
      branch: env.SEDUM_BRANCH || ci.branch || gitBranch,
      sha: env.SEDUM_COMMIT_SHA || gitSha || ci.sha,
      url: ci.url,
    },
    gitProblems,
  );
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
  // `runs show` reads the Cloud row's UUID, not the report's local run ID.
  return outcome.cloudRunId
    ? `Cloud upload: accepted run ${outcome.cloudRunId} (local run ${execution.result.runId}). View it with \`sedum runs show ${outcome.cloudRunId}\`.\n`
    : warning(outcome.reason);
}

async function deliverReport(
  request: UploadRequest,
): Promise<{ cloudRunId?: string | undefined; reason: string }> {
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
    } catch (error) {
      // Fetch errors and response bodies can contain credentials or report data.
      if (error instanceof TypeError)
        reason = unreachable(request.target.url, error);
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
    reason: signal.aborted
      ? `delivery to ${request.target.url.origin} exceeded the 5 second budget`
      : reason,
  };
}

function unreachable(url: URL, error: TypeError): string {
  // Only a system error code such as ECONNREFUSED, never the error message.
  const code = String(Object(error.cause).code);
  const detail = /^[A-Z0-9_]{1,64}$/u.test(code) ? ` (${code})` : "";
  return `could not reach ${url.origin}${detail}; check SEDUM_CLOUD_URL and the network`;
}

function httpReason(status: number, request: UploadRequest): string {
  const hints: Record<number, string> = {
    401: `SEDUM_UPLOAD_TOKEN is revoked or is not an upload credential for SEDUM_PROJECT_ID ${request.target.projectId}`,
    404: `no Sedum Cloud upload endpoint at ${request.target.url.href}; check SEDUM_CLOUD_URL`,
    409: `Cloud already has a different report for run ${request.runId}`,
  };
  const hint =
    status >= 300 && status < 400
      ? "Cloud redirected; set SEDUM_CLOUD_URL to the final https:// address"
      : hints[status];
  return hint ? `HTTP ${status} (${hint})` : `HTTP ${status}`;
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
    const receipt = z
      .object({
        id: z.uuid(),
        status: z.literal("accepted"),
        project_id: z.literal(request.target.projectId),
        run_id: z.literal(request.runId),
      })
      .safeParse(await response.json());
    return {
      cloudRunId: receipt.data?.id,
      reason: "Cloud returned an invalid upload receipt",
      retryAfter: null,
    };
  }
  const retryable =
    [408, 429].includes(response.status) || response.status >= 500;
  const wait = parseRetryAfter(response.headers, Date.now());
  await response.body?.cancel();
  return {
    reason: httpReason(response.status, request),
    // null stops delivery; undefined uses this attempt's exponential backoff.
    retryAfter: retryable ? (wait ?? undefined) : null,
  };
}
