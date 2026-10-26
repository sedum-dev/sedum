import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RunRecorder,
  validateRunResult,
  type ResultStep,
  type RunResult,
} from "@sedum-dev/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliRuntime } from "./run-cli.js";
import type { RunCommandExecution } from "./run-command.js";

const projectId = "11111111-2222-4333-8444-555555555555";
const cloudRunId = "99999999-8888-4777-8666-555555555555";
const token = `sdu_${"a".repeat(43)}`;
const sha = "1234567890abcdef1234567890abcdef12345678";
const originalEnv = process.env;
const originalCwd = process.cwd();
let root: string;
let requests: { url: string; headers: IncomingHttpHeaders; body: string }[];
let respond: (response: ServerResponse, body: RunResult) => void;
let server: ReturnType<typeof createServer>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "sedum-cloud-upload-"));
  process.chdir(root);
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env)) {
    if (/^(?:SEDUM_|GITHUB_|GITLAB_|CI_)/u.test(key)) delete process.env[key];
  }
  requests = [];
  respond = (response, body) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: cloudRunId,
        run_id: body.runId,
        project_id: projectId,
        status: "accepted",
      }),
    );
  };
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    requests.push({ url: request.url!, headers: request.headers, body });
    respond(response, JSON.parse(body) as RunResult);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server address");
  Object.assign(process.env, {
    SEDUM_CLOUD_URL: `http://127.0.0.1:${address.port}/cloud`,
    SEDUM_PROJECT_ID: projectId,
    SEDUM_UPLOAD_TOKEN: token,
    SEDUM_BRANCH: "feature/checkout",
    SEDUM_COMMIT_SHA: sha,
  });
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.env = originalEnv;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

async function execution(
  outcome: "passed" | "failed" | "interrupted" | "error" | "flagged" = "passed",
): Promise<RunCommandExecution> {
  const recorder = new RunRecorder(async () => undefined, "cloud-fixture");
  await recorder.start();
  await recorder.startTest({ id: "checkout", file: "checkout.test.yaml" });
  if (outcome === "error" || outcome === "interrupted") {
    await recorder.finish(
      { code: "canceled", message: "Execution stopped" },
      outcome,
    );
  } else {
    const step: ResultStep = {
      id: "verify",
      index: 1,
      kind: "verify",
      operation: "verify",
      phase: "steps",
      sentence: "verify checkout",
      detail: "",
      sourceStack: [{ file: "checkout.test.yaml", line: 3, col: 5 }],
      state: "completed",
      verdict: outcome === "failed" ? "failed" : "passed",
      flags: outcome === "flagged" ? ["low_confidence"] : [],
      elapsedMs: 1,
      page: { status: "unavailable", reason: "fixture" },
      locator: null,
      judgement: null,
      observations: [],
      calls: [],
      error: null,
      evidence: { status: "omitted", reason: "fixture" },
      replayFrame: null,
      targetBox: null,
    };
    await recorder.addStep(step);
    await recorder.finishTest(step.verdict!);
    await recorder.finish();
  }
  const result = validateRunResult(recorder.snapshot);
  const resultPath = path.join(root, "result.json");
  const progressPath = path.join(root, "progress.json");
  await writeFile(resultPath, JSON.stringify(result));
  await writeFile(progressPath, JSON.stringify(result));
  return {
    result,
    artifacts: { resultPath, progressPath, authoritative: true },
    diagnostic: null,
  };
}

function invoke(
  value: RunCommandExecution,
  args: string[] = [],
  runtime: CliRuntime = {},
) {
  return runCli(
    ["run", "checkout.test.yaml", "--reporter", "json", ...args],
    "0.0.0",
    {
      executeRun: async () => value,
      ...runtime,
    },
  );
}

describe("automatic Cloud upload through sedum run", () => {
  it.each([
    ["passed", 0],
    ["failed", 1],
    ["interrupted", 3],
    ["error", 3],
    ["flagged", 2],
  ] as const)(
    "uploads a saved %s result without changing its exit code",
    async (outcome, code) => {
      const value = await execution(outcome);
      const controller = new AbortController();
      if (outcome === "interrupted") controller.abort();
      const output = await invoke(value, ["--strict"], {
        signal: controller.signal,
      });
      expect(output.exitCode).toBe(code);
      // The printed ID is the one `sedum runs show` reads, not the local run ID.
      expect(output.stderr).toContain(
        `Cloud upload: accepted run ${cloudRunId} (local run ${value.result.runId})`,
      );
      expect(output.stderr).toContain(`sedum runs show ${cloudRunId}`);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`/cloud/api/projects/${projectId}/runs`);
      expect(requests[0]!.headers).toMatchObject({
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-sedum-branch": "feature/checkout",
        "x-sedum-commit-sha": sha,
      });
      expect(JSON.parse(requests[0]!.body)).toEqual(value.result);
      expect(await readFile(value.artifacts.resultPath, "utf8")).toBe(
        requests[0]!.body,
      );
      expect(await readFile(value.artifacts.progressPath, "utf8")).toBe(
        requests[0]!.body,
      );
      expect(output.stdout + output.stderr).not.toContain(token);
    },
  );

  it("retries network errors and throttling with exactly the same report and context", async () => {
    const accepted = respond;
    respond = (response, body) => {
      if (requests.length === 1) response.destroy();
      else if (requests.length === 2) {
        response.writeHead(429, { "retry-after": "0" });
        response.end(token);
      } else accepted(response, body);
    };
    const value = await execution();
    const output = await invoke(value, [], {
      executeRun: async () => {
        process.env.SEDUM_BRANCH = "main";
        process.env.SEDUM_COMMIT_SHA = "b".repeat(40);
        process.env.SEDUM_UPLOAD_TOKEN = "revoked-during-run";
        return value;
      },
    });
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toContain("Cloud upload: accepted");
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.body)).size).toBe(1);
    for (const request of requests)
      expect(request.headers).toMatchObject({
        authorization: `Bearer ${token}`,
        "x-sedum-branch": "feature/checkout",
        "x-sedum-commit-sha": sha,
      });
    expect(output.stdout + output.stderr).not.toContain(token);
  });

  it("pins the destination and project before tests execute", async () => {
    let unexpectedRequests = 0;
    const otherServer = createServer((_request, response) => {
      unexpectedRequests++;
      response.end();
    });
    otherServer.listen(0, "127.0.0.1");
    await once(otherServer, "listening");
    try {
      const address = otherServer.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test server address");
      const value = await execution();
      const output = await invoke(value, [], {
        executeRun: async () => {
          process.env.SEDUM_CLOUD_URL = `http://127.0.0.1:${address.port}/other`;
          process.env.SEDUM_PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
          return value;
        },
      });
      expect(output.stderr).toContain("Cloud upload: accepted");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe(`/cloud/api/projects/${projectId}/runs`);
      expect(unexpectedRequests).toBe(0);
    } finally {
      otherServer.closeAllConnections();
      await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    }
  });

  it.each([
    {
      status: 401,
      outcome: "passed",
      code: 0,
      attempts: 1,
      cause: `SEDUM_UPLOAD_TOKEN is revoked or is not an upload credential for SEDUM_PROJECT_ID ${projectId}`,
    },
    {
      status: 409,
      outcome: "failed",
      code: 1,
      attempts: 1,
      cause: "Cloud already has a different report for run",
    },
    {
      status: 404,
      outcome: "passed",
      code: 0,
      attempts: 1,
      cause: "no Sedum Cloud upload endpoint at http://127.0.0.1",
    },
    {
      status: 422,
      outcome: "failed",
      code: 1,
      attempts: 1,
      cause: "HTTP 422.",
    },
    {
      status: 503,
      outcome: "passed",
      code: 0,
      attempts: 3,
      cause: "HTTP 503.",
    },
  ] as const)(
    "HTTP $status preserves the test verdict and retries only transient failures",
    async ({ status, outcome, code, attempts, cause }) => {
      respond = (response) => {
        response.writeHead(status);
        response.end(token);
      };
      const value = await execution(outcome);
      const output = await invoke(value);
      expect(output.exitCode).toBe(code);
      expect(requests).toHaveLength(attempts);
      expect(output.stderr).toContain(`Cloud upload warning: HTTP ${status}`);
      expect(output.stderr).toContain(cause);
      expect(output.stderr).toContain(value.artifacts.resultPath);
      expect(output.stderr).not.toContain(token);
      expect(
        JSON.parse(await readFile(value.artifacts.resultPath, "utf8")),
      ).toEqual(value.result);
    },
  );

  it("bounds even a hanging successful response body to five seconds", async () => {
    respond = (response) => {
      response.writeHead(200);
      response.flushHeaders();
    };
    const started = Date.now();
    const output = await invoke(await execution());
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toContain(
      `delivery to ${new URL(process.env.SEDUM_CLOUD_URL!).origin} exceeded the 5 second budget`,
    );
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(requests).toHaveLength(1);
  }, 15_000);

  it("names an unreachable Cloud host without changing the exit code", async () => {
    const closed = createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const address = closed.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test server address");
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    process.env.SEDUM_CLOUD_URL = `http://127.0.0.1:${address.port}`;
    const output = await invoke(await execution("failed"));
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain(
      `Cloud upload warning: could not reach http://127.0.0.1:${address.port} (ECONNREFUSED); check SEDUM_CLOUD_URL`,
    );
    expect(output.stderr).not.toContain(token);
  });

  it.each([
    ["unconfigured", ""],
    ["opt-out", ""],
    ["partial", "SEDUM_UPLOAD_TOKEN not set"],
    ["malformed-token", "SEDUM_UPLOAD_TOKEN must be the project's sdu_"],
    ["read-token", "SEDUM_UPLOAD_TOKEN must be the project's sdu_"],
    ["bad-project", "SEDUM_PROJECT_ID must be the Cloud project UUID"],
    ["remote-http", "SEDUM_CLOUD_URL must be an https:// base URL"],
    ["unsafe-url", "SEDUM_CLOUD_URL must be an https:// base URL"],
    [
      "no-context",
      "no source branch detected (for example a detached checkout); set SEDUM_BRANCH; no commit detected; set SEDUM_COMMIT_SHA",
    ],
  ])("does not upload when %s", async (mode, cause) => {
    const value = await execution();
    const overrides: Record<string, string> = {
      "malformed-token": "SEDUM_UPLOAD_TOKEN=sdu_secret",
      "read-token": `SEDUM_UPLOAD_TOKEN=sdr_${"s".repeat(43)}`,
      "bad-project": "SEDUM_PROJECT_ID=secret-project",
      "remote-http": "SEDUM_CLOUD_URL=http://cloud.example/secret",
    };
    if (overrides[mode]) {
      const [key, setting] = overrides[mode].split("=") as [string, string];
      process.env[key] = setting;
    }
    if (mode === "unconfigured") {
      delete process.env.SEDUM_CLOUD_URL;
      delete process.env.SEDUM_PROJECT_ID;
      delete process.env.SEDUM_UPLOAD_TOKEN;
    }
    if (mode === "partial") delete process.env.SEDUM_UPLOAD_TOKEN;
    if (mode === "no-context") {
      delete process.env.SEDUM_BRANCH;
      delete process.env.SEDUM_COMMIT_SHA;
    }
    if (mode === "unsafe-url")
      process.env.SEDUM_CLOUD_URL =
        "https://user:secret@example.invalid/?token=secret";
    const output = await invoke(
      value,
      mode === "opt-out" ? ["--no-cloud"] : [],
    );
    expect(requests).toHaveLength(0);
    expect(output.exitCode).toBe(0);
    if (cause)
      expect(output.stderr).toContain(`Cloud upload skipped: ${cause}`);
    else expect(output.stderr).not.toContain("Cloud upload");
    expect(output.stderr).not.toContain("secret");
  });

  it.each(["unsaved", "running"])("never uploads a %s report", async (mode) => {
    const value = await execution();
    const selected: RunCommandExecution =
      mode === "unsaved"
        ? { ...value, artifacts: { ...value.artifacts, authoritative: false } }
        : {
            ...value,
            result: { ...value.result, state: "running", finishedAt: null },
          };
    expect((await invoke(selected)).stderr).toContain(
      "no authoritative terminal report",
    );
    expect(requests).toHaveLength(0);
  });

  it("uses project dotenv settings, with process values taking precedence", async () => {
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "tests: { directory: tests }\n",
    );
    await writeFile(
      path.join(root, ".env"),
      `SEDUM_CLOUD_URL=${process.env.SEDUM_CLOUD_URL}\nSEDUM_PROJECT_ID=${projectId}\nSEDUM_UPLOAD_TOKEN=${token}\nSEDUM_BRANCH=dotenv-branch\nSEDUM_COMMIT_SHA=${sha}\n`,
    );
    delete process.env.SEDUM_CLOUD_URL;
    delete process.env.SEDUM_PROJECT_ID;
    delete process.env.SEDUM_UPLOAD_TOKEN;
    const output = await invoke(await execution());
    expect(output.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers["x-sedum-branch"]).toBe("feature/checkout");
  });

  it.each([
    "http://gitlab.internal/group/project/-/jobs/123",
    "not a URL",
    "https://user:secret@gitlab.example/jobs/123",
    `https://gitlab.example/${"a".repeat(2048)}`,
  ])(
    "uploads without an unusable optional CI link (case %#)",
    async (ciUrl) => {
      process.env.GITLAB_CI = "true";
      process.env.CI_JOB_URL = ciUrl;
      const output = await invoke(await execution());
      expect(output.exitCode).toBe(0);
      expect(output.stderr).toContain("Cloud upload: accepted");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers["x-sedum-ci-url"]).toBeUndefined();
      expect(requests[0]!.headers["x-sedum-branch"]).toBe("feature/checkout");
      expect(output.stdout + output.stderr).not.toContain(ciUrl);
    },
  );

  it("sends Unicode branches as their original UTF-8 wire bytes", async () => {
    const branch = "feature/café-日本語-🚀";
    process.env.SEDUM_BRANCH = branch;
    const output = await invoke(await execution());
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toContain("Cloud upload: accepted");
    expect(requests).toHaveLength(1);
    const wireHeader = requests[0]!.headers["x-sedum-branch"] as string;
    expect(Buffer.from(wireHeader, "latin1").toString("utf8")).toBe(branch);
  });

  it("detects local Git context and refuses to guess a detached branch", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-b", "topic/orders");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    delete process.env.SEDUM_BRANCH;
    delete process.env.SEDUM_COMMIT_SHA;
    const value = await execution();
    expect((await invoke(value)).stderr).toContain("Cloud upload: accepted");
    expect(requests[0]!.headers).toMatchObject({
      "x-sedum-branch": "topic/orders",
      "x-sedum-commit-sha": git("rev-parse", "HEAD"),
    });
    git("checkout", "--detach");
    expect((await invoke(value)).stderr).toContain("Cloud upload skipped");
    expect(requests).toHaveLength(1);
    Object.assign(process.env, {
      GITHUB_ACTIONS: "true",
      GITHUB_HEAD_REF: "fix/checkout",
      GITHUB_REF: "refs/pull/42/merge",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "example/shop",
      GITHUB_RUN_ID: "42",
    });
    expect((await invoke(value)).stderr).toContain("Cloud upload: accepted");
    expect(requests[1]!.headers).toMatchObject({
      "x-sedum-branch": "fix/checkout",
      "x-sedum-commit-sha": git("rev-parse", "HEAD"),
      "x-sedum-ci-url": "https://github.com/example/shop/actions/runs/42",
    });
  });

  it("does not follow redirects or accept a receipt for another project", async () => {
    respond = (response) => {
      response.writeHead(302, {
        location: `${process.env.SEDUM_CLOUD_URL}/other`,
      });
      response.end();
    };
    const value = await execution();
    expect((await invoke(value)).stderr).toContain(
      "Cloud upload warning: HTTP 302 (Cloud redirected; set SEDUM_CLOUD_URL",
    );
    expect(requests).toHaveLength(1);
    expect(
      requests.every((request) =>
        request.url.endsWith(`/projects/${projectId}/runs`),
      ),
    ).toBe(true);
    respond = (response, body) =>
      response.end(
        JSON.stringify({
          id: "another-run",
          run_id: body.runId,
          project_id: "wrong",
          status: "accepted",
        }),
      );
    expect((await invoke(value)).stderr).toContain("invalid upload receipt");
  });

  it("uploads the rewritten terminal report when a final reporter fails", async () => {
    const value = await execution();
    const rewritten = await execution("error");
    let failed = false;
    const output = await invoke(
      { ...value, onReporterFailure: async () => rewritten },
      ["--reporter", "list"],
      {
        stdout: () => {
          if (!failed) {
            failed = true;
            throw new Error("broken terminal");
          }
        },
      },
    );
    expect(output.exitCode).toBe(3);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body)).toEqual(rewritten.result);
    expect(output.stderr).toContain("Cloud upload: accepted");
  });
});
