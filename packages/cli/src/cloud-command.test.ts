import { once } from "node:events";
import { spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runCli } from "./run-cli.js";

const id = "b150e9cc-fb47-4f95-a471-100000000001";
const window = {
  since: "2026-10-13T12:00:00.000Z",
  until: "2026-10-20T12:00:00.000Z",
};
const run = {
  id,
  run_id: "sedum run",
  state: "completed",
  verdict: "passed",
  branch: "main",
  totals: { tests: 1 },
};
const metric = {
  test_id: "sedum run",
  description: "sedum tests",
  observation_count: 3,
  passed_count: 2,
  failed_count: 1,
  unknown_count: 0,
  completed_count: 3,
  recovered_retry_count: 1,
  retry_count: 2,
  failure_rate: 1 / 3,
  recovered_retry_rate: 1 / 3,
  mixed_outcomes: true,
  duration_count: 3,
  mean_elapsed_ms: 200,
  max_elapsed_ms: 300,
  p50_elapsed_ms: 200,
  p95_elapsed_ms: 300,
  total_attempt_elapsed_ms: 900,
  retry_elapsed_ms: 300,
};
let root: string;
let origin: string;
let server: ReturnType<typeof createServer>;
let seen: { url: URL; access: string | undefined }[];
let projects: { id: string; name: string }[];
let failures: number;
let status: number;
let tokenStatus: number;
let malformed: boolean;
let statRow: Record<string, unknown>;

function respond(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, origin);
  seen.push({ url, access: req.headers.authorization });
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/oauth/token") {
    res.statusCode = tokenStatus;
    res.end(
      JSON.stringify(
        tokenStatus === 200
          ? {
              token_type: "Bearer",
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
            }
          : { error: "secret-refresh" },
      ),
    );
  } else if (url.pathname === "/api/auth/me") {
    res.end(
      JSON.stringify({
        user: { id: "user", name: null, email: null },
        organizations: [{ id: "org", name: "Team", role: "member", projects }],
      }),
    );
  } else if (failures-- > 0) {
    res.statusCode = 401;
    res.end('{"error":"secret-access"}');
  } else if (status !== 200) {
    res.statusCode = status;
    res.end('{"error":"secret-access secret-refresh"}');
  } else res.end(JSON.stringify(fixtureBody(url)));
}
function fixtureBody(url: URL): unknown {
  if (malformed) return { data: "secret-access" };
  if (url.pathname.endsWith("/stats")) {
    return {
      data: [statRow],
      complete: true,
      run_count: 3,
      test_count: 1,
      window,
      sort: url.searchParams.get("sort"),
      limit: 25,
      min_observations: 1,
      comparison_window: window,
      previous_run_count: 3,
      previous_test_count: 1,
    };
  }
  if (url.pathname.endsWith(id)) {
    return {
      ...run,
      ...(url.searchParams.get("include_report") === "true"
        ? { report: { note: "sedum run and sedum tests" } }
        : {}),
    };
  }
  if (url.pathname.endsWith("/history"))
    return {
      data: [
        {
          ...run,
          tests: [
            {
              test_id: url.searchParams.get("test_id"),
              state: "completed",
              verdict: "passed",
              retry_count: 0,
            },
          ],
        },
      ],
      next_cursor: "opaque+/=",
      window,
    };
  return { data: [run], next_cursor: "opaque+/=", window };
}
beforeEach(async () => {
  root = await mkdtemp(
    path.join(await realpath(tmpdir()), "sedum-cloud-read-"),
  );
  seen = [];
  projects = [{ id: "project", name: "Web" }];
  failures = 0;
  status = 200;
  tokenStatus = 200;
  malformed = false;
  statRow = {
    ...metric,
    previous: metric,
    p95_change_ms: 0,
    p95_change_ratio: 0,
  };
  server = createServer(respond);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  origin = `http://127.0.0.1:${address.port}`;
  await writeFile(
    path.join(root, "auth.json"),
    JSON.stringify({
      selectedOrigin: origin,
      selections: { [origin]: { organization: "org", project: "project" } },
      sessions: {
        [origin]: {
          token_type: "Bearer",
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          expires_in: 3600,
          expiresAt: Date.now() + 3600000,
        },
      },
    }),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
function cli(args: string[]) {
  return runCli(args, "test", {
    auth: {
      configDirectory: root,
      choose: async () => {
        throw new Error("must not prompt");
      },
    },
    command: "npx sedum",
  });
}
function reads() {
  return seen.filter(({ url }) => url.pathname.startsWith("/api/projects/"));
}

it("uses saved selections and reads exactly one compact page with fixed relative anchor", async () => {
  const result = await cli(["runs", "list", "--json", "--until", window.until]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    project: { id: "project" },
    data: [run],
    next_cursor: "opaque+/=",
    window,
  });
  expect(reads()).toHaveLength(1);
  expect(Object.fromEntries(reads()[0]!.url.searchParams)).toEqual({
    ...window,
    limit: "25",
  });
  expect(seen[0]!.url.pathname).toBe("/api/auth/me");
  expect(result.stdout).not.toContain("secret-access");
});
it("encodes exact test IDs, filters and cursors without injecting parameters", async () => {
  const exact = "checkout/+?&test_id=other#雪 ' OR 1=1 -- sedum run";
  const result = await cli([
    "tests",
    "history",
    "--test-id",
    exact,
    "--branch",
    "feature/&state=error",
    "--cursor",
    "a+/=&#",
    "--commit-sha",
    "a".repeat(40),
    "--state",
    "completed",
    "--verdict",
    "failed",
    "--limit",
    "100",
    "--since",
    "24h",
    "--until",
    window.until,
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
  const params = reads()[0]!.url.searchParams;
  expect(params.get("test_id")).toBe(exact);
  expect(params.getAll("state")).toEqual(["completed"]);
  expect(params.get("cursor")).toBe("a+/=&#");
  expect(params.get("since")).toBe("2026-10-19T12:00:00.000Z");
  expect(reads()).toHaveLength(1);
});
it("refreshes a GET 401 once, persists rotation, and keeps JSON strings byte-for-byte", async () => {
  failures = 1;
  const result = await cli(["runs", "show", id, "--report", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).report.note).toBe(
    "sedum run and sedum tests",
  );
  expect(reads().map(({ access }) => access)).toEqual([
    "Bearer secret-access",
    "Bearer rotated-access",
  ]);
  const stored = JSON.parse(
    await readFile(path.join(root, "auth.json"), "utf8"),
  );
  expect(stored.sessions[origin].refresh_token).toBe("rotated-refresh");
  expect(result.stdout + result.stderr).not.toContain("rotated-access");
});
it("requests compact show by default and report only on opt-in", async () => {
  expect((await cli(["runs", "show", id, "--json"])).stdout).not.toContain(
    '"report"',
  );
  expect(reads()[0]!.url.searchParams.get("include_report")).toBe("false");
  expect((await cli(["runs", "show", id, "--report"])).stdout).toContain(
    '"note": "sedum run and sedum tests"',
  );
  expect(reads()[1]!.url.searchParams.get("include_report")).toBe("true");
});
it("preserves exact test IDs and scope names in human-readable history", async () => {
  projects[0]!.name = "sedum tests";
  const result = await cli(["tests", "history", "--test-id", "sedum run"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"Team" / "sedum tests"');
  expect(result.stdout).toContain('test_id="sedum run"');
});
it("escapes terminal control characters in Cloud scope names", async () => {
  projects[0]!.name = "Web\u001b[2J\nforged output";
  const result = await cli(["runs", "list"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("\u001b");
  expect(result.stdout).toContain('"Web\\u001b[2J\\nforged output"');
});
it("selects explicit current names without changing saved defaults, rejects ambiguous names", async () => {
  projects.push({ id: "second", name: "Other" });
  expect(
    (
      await cli([
        "runs",
        "list",
        "--project",
        "Other",
        "--organization",
        "Team",
        "--url",
        origin,
      ])
    ).exitCode,
  ).toBe(0);
  expect(reads()[0]!.url.pathname).toBe("/api/projects/second/runs");
  expect(
    JSON.parse(await readFile(path.join(root, "auth.json"), "utf8")).selections[
      origin
    ].project,
  ).toBe("project");
  projects.push({ id: "third", name: "Other" });
  const result = await cli(["runs", "list", "--project", "Other", "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("unambiguous name");
});
it.each([
  "flaky-runs",
  "flake-rate",
  "failures",
  "retry-overhead",
  "duration-p95",
  "duration-regression",
])("preserves ranked stats and comparison for %s", async (sort) => {
  const result = await cli([
    "tests",
    "stats",
    "--sort",
    sort,
    "--compare",
    "previous",
    "--min-observations",
    "3",
    "--test-id",
    "sedum run",
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    sort,
    complete: true,
    previous_run_count: 3,
    data: [{ ...metric, previous: metric, p95_change_ratio: 0 }],
  });
  expect(reads()[0]!.url.searchParams.get("min_observations")).toBe("3");
});
it.each([
  ["runs", "list", "--since", "32d"],
  ["runs", "list", "--since", "0h"],
  ["runs", "list", "--until", "2026-10-20"],
  ["runs", "list", "--since", "2026-02-30T00:00:00Z"],
  ["runs", "list", "--limit", "101"],
  ["runs", "list", "--state", "bogus"],
  ["runs", "list", "--commit-sha", "bad"],
  ["tests", "history"],
  ["tests", "stats", "--sort", "duration-regression"],
  ["tests", "stats", "--sort", "bogus"],
  ["tests", "stats", "--compare", "next"],
  ["tests", "stats", "--min-observations", "1001"],
  ["runs", "show", "not-a-uuid"],
])("validates before any network: %j", async (...args) => {
  const result = await cli(args);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("");
  expect(seen).toHaveLength(0);
});
it.each([400, 401, 403, 404, 422, 429, 500])(
  "maps HTTP %s without printing server secrets",
  async (code) => {
    status = code;
    const result = await cli(["runs", "list", "--json"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/secret-|rotated-/);
    if (code === 401) {
      expect(reads()).toHaveLength(2);
      expect(result.stderr).toContain("npx sedum auth login");
    }
    if (code === 422) expect(result.stderr).toContain("Narrow");
  },
);
it("explains that a missing run needs the Cloud run UUID, not the local run ID", async () => {
  status = 404;
  const shown = await cli(["runs", "show", id]);
  expect(shown.exitCode).toBe(3);
  expect(shown.stderr).toContain("Cloud run UUID");
  expect(shown.stderr).toContain("not the local run ID");
  expect(shown.stderr).not.toContain("membership");
  const listed = await cli(["runs", "list"]);
  expect(listed.exitCode).toBe(3);
  expect(listed.stderr).toContain("membership");
});
it("fails safely on revoked refresh and malformed success", async () => {
  failures = 1;
  tokenStatus = 400;
  expect((await cli(["runs", "list"])).stderr).toContain("auth login");
  tokenStatus = 200;
  malformed = true;
  const result = await cli(["tests", "stats", "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("invalid read response");
  expect(result.stderr).not.toContain("secret-");
});
it("refreshes expired credentials before checking live membership", async () => {
  const file = path.join(root, "auth.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.sessions[origin].expiresAt = 0;
  await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
  const result = await cli(["runs", "list", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(seen.map(({ url }) => url.pathname)).toEqual([
    "/api/oauth/token",
    "/api/auth/me",
    "/api/projects/project/runs",
  ]);
  expect(seen[1]!.access).toBe("Bearer rotated-access");
});
it("honors the auth store exclusive lock without fetching or prompting", async () => {
  await writeFile(path.join(root, "auth.lock"), "", { mode: 0o600 });
  const result = await cli(["runs", "list", "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("store is locked");
  expect(seen).toHaveLength(0);
});
async function deadLock(file: string, pidNamespace: string | undefined) {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  await writeFile(
    file,
    JSON.stringify({ pid: child.pid, host: hostname(), pidNamespace }),
    { mode: 0o600 },
  );
}
function pidNamespace(): string | undefined {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}
it("recovers a lock and an abandoned break guard left by killed processes", async () => {
  await deadLock(path.join(root, "auth.lock"), pidNamespace());
  const guard = path.join(root, "auth.lock.break");
  await deadLock(guard, pidNamespace());
  const old = new Date(Date.now() - 60_000);
  await utimes(guard, old, old);
  const result = await cli(["runs", "list", "--json"]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(await readdir(root)).toEqual(["auth.json"]);
});
it("keeps a lock whose owner ran in another PID namespace", async () => {
  await deadLock(path.join(root, "auth.lock"), "pid:[1]");
  const result = await cli(["runs", "list", "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stderr).toContain("store is locked");
  expect(seen).toHaveLength(0);
});
it("ends quietly and releases the auth lock when the stdout reader closes early", async () => {
  // The real binary: the crash was an unhandled EPIPE on process.stdout.
  await mkdir(path.join(root, "sedum"), { mode: 0o700 });
  await rename(
    path.join(root, "auth.json"),
    path.join(root, "sedum/auth.json"),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      "tests",
      "stats",
      "--json",
    ],
    { env: { ...process.env, XDG_CONFIG_HOME: root } },
  );
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [code] = await once(child, "exit");
  expect(reads()).toHaveLength(1);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(await readdir(path.join(root, "sedum"))).toEqual(["auth.json"]);
}, 15_000);
it("uses current memberships, not removed saved projects or interactive chooser", async () => {
  projects = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const result = await cli(["runs", "list", "--json"]);
  expect(result.exitCode).toBe(3);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("--project");
  expect(reads()).toHaveLength(0);
});
it("preserves missing duration, outcome and comparison baselines as null", async () => {
  statRow = {
    ...metric,
    failure_rate: null,
    recovered_retry_rate: null,
    mean_elapsed_ms: null,
    max_elapsed_ms: null,
    p50_elapsed_ms: null,
    p95_elapsed_ms: null,
    previous: null,
    p95_change_ms: null,
    p95_change_ratio: null,
  };
  const result = await cli([
    "tests",
    "stats",
    "--compare",
    "previous",
    "--json",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).data).toEqual([statRow]);
});
