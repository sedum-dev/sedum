import { z } from "zod";
import type { Command } from "commander";
import { AuthError } from "./auth-api.js";
import type { AuthOptions, AuthRuntime } from "./auth-command.js";

interface Options extends AuthOptions {
  json?: boolean;
  report?: boolean;
  since?: string;
  until?: string;
  branch?: string;
  commitSha?: string;
  state?: string;
  verdict?: string;
  limit?: string;
  cursor?: string;
  testId?: string;
  sort?: string;
  minObservations?: string;
  compare?: string;
}
type Kind = "list" | "show" | "history" | "stats";
const sorts = [
  "flaky-runs",
  "flake-rate",
  "failures",
  "retry-overhead",
  "duration-p95",
  "duration-regression",
] as const;
const windowSchema = z.object({
  since: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
});
const count = z.number().int().nonnegative();
const duration = z.number().nonnegative().nullable();
const metrics = z
  .object({
    test_id: z.string(),
    observation_count: count,
    passed_count: count,
    failed_count: count,
    unknown_count: count,
    completed_count: count,
    recovered_retry_count: count,
    retry_count: count,
    failure_rate: z.number().min(0).max(1).nullable(),
    recovered_retry_rate: z.number().min(0).max(1).nullable(),
    mixed_outcomes: z.boolean(),
    duration_count: count,
    mean_elapsed_ms: duration,
    max_elapsed_ms: duration,
    description: z.string().nullable(),
    p50_elapsed_ms: duration,
    p95_elapsed_ms: duration,
    total_attempt_elapsed_ms: z.number().nonnegative(),
    retry_elapsed_ms: z.number().nonnegative(),
  })
  .passthrough();
const row = metrics.extend({
  previous: metrics.nullable().optional(),
  p95_change_ms: z.number().nullable().optional(),
  p95_change_ratio: z.number().nullable().optional(),
});
const summary = z
  .object({
    id: z.uuid(),
    state: z.enum(["completed", "interrupted", "error"]),
    verdict: z.enum(["passed", "failed"]).nullable(),
    report: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const page = z
  .object({
    data: z.array(summary),
    next_cursor: z.string().nullable(),
    window: windowSchema,
  })
  .passthrough();
const history = page.extend({
  data: z.array(
    summary.extend({
      tests: z.array(
        z
          .object({
            test_id: z.string(),
            state: z.string(),
            verdict: z.enum(["passed", "failed"]).nullable(),
            retry_count: count,
          })
          .passthrough(),
      ),
    }),
  ),
});
const stats = z
  .object({
    data: z.array(row),
    run_count: z.number().nonnegative(),
    test_count: z.number().nonnegative(),
    complete: z.literal(true),
    window: windowSchema,
    sort: z.enum(sorts),
    limit: z.number(),
    min_observations: z.number(),
    comparison_window: windowSchema.optional(),
    previous_run_count: count.optional(),
    previous_test_count: count.optional(),
  })
  .passthrough();

function integer(value: string, name: string, max: number): string {
  if (
    !z
      .string()
      .regex(/^\d+$/)
      .pipe(z.coerce.number<string>().int().min(1).max(max))
      .safeParse(value).success
  )
    throw new AuthError(`${name} must be an integer from 1 to ${max}.`);
  return String(Number(value));
}
function timestamp(value: string): number {
  if (!z.iso.datetime({ offset: true }).safeParse(value).success)
    throw new AuthError(
      "Use an ISO timestamp with timezone (for example 2026-10-20T12:00:00Z).",
    );
  return Date.parse(value);
}
function timeWindow(options: Options): { since: string; until: string } {
  const until = options.until ? timestamp(options.until) : Date.now();
  const sinceValue = options.since ?? "7d";
  const relative = /^([1-9]\d*)([dh])$/.exec(sinceValue);
  const since = relative
    ? until - Number(relative[1]) * (relative[2] === "d" ? 86400000 : 3600000)
    : timestamp(sinceValue);
  if (
    !z
      .number()
      .positive()
      .max(31 * 86400000)
      .safeParse(until - since).success
  )
    throw new AuthError(
      "Time window must be positive and at most 31 days. Narrow --since/--until.",
    );
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
  };
}
function validateComparison(options: Options, sort: string): void {
  if (!z.literal("previous").optional().safeParse(options.compare).success)
    throw new AuthError("--compare must be previous.");
  if (sort === "duration-regression" && !options.compare)
    throw new AuthError(
      "--sort duration-regression requires --compare previous.",
    );
}
function statsFilters(options: Options, params: URLSearchParams): void {
  const parsed = z.enum(sorts).default("flaky-runs").safeParse(options.sort);
  if (!parsed.success)
    throw new AuthError(`--sort must be one of: ${sorts.join(", ")}.`);
  const sort = parsed.data;
  validateComparison(options, sort);
  params.set("sort", sort);
  params.set(
    "min_observations",
    integer(options.minObservations ?? "1", "--min-observations", 1000),
  );
  if (options.compare !== undefined) params.set("compare", options.compare);
}
function validateTextFilters(options: Options): void {
  const valid = z
    .object({
      branch: z.string().min(1).max(512).optional(),
      commitSha: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .optional(),
      state: z.enum(["completed", "interrupted", "error"]).optional(),
      verdict: z.enum(["passed", "failed"]).optional(),
      testId: z.string().min(1).max(8192).optional(),
      cursor: z.string().min(1).max(4096).optional(),
    })
    .safeParse(options);
  if (!valid.success)
    throw new AuthError(
      "Invalid --branch, --commit-sha, --state, --verdict, --test-id or --cursor filter. See --help.",
    );
}
function filters(kind: Kind, options: Options): URLSearchParams {
  if (kind === "show")
    return new URLSearchParams({
      include_report: String(options.report === true),
    });
  validateTextFilters(options);
  const params = new URLSearchParams(timeWindow(options));
  params.set("limit", integer(options.limit ?? "25", "--limit", 100));
  for (const [key, value] of Object.entries({
    branch: options.branch,
    commit_sha: options.commitSha,
    state: options.state,
    verdict: options.verdict,
    test_id: options.testId,
    cursor: options.cursor,
  })) {
    if (value !== undefined) params.set(key, value);
  }
  if (kind === "history" && !options.testId)
    throw new AuthError("--test-id <exact-id> is required.");
  if (kind === "stats") statsFilters(options, params);
  return params;
}
function statusError(status: number): AuthError {
  const messages: Record<number, string> = {
    401: "Session unavailable. Run `sedum auth login` again.",
    403: "Project or run unavailable to your current membership.",
    404: "Project or run unavailable to your current membership.",
    400: "Invalid Cloud filters. Check the command options.",
    422: "Cloud query exceeds its bounded sample. Narrow the time window or --branch.",
    429: "Cloud rate limit reached. Back off and retry later.",
  };
  return new AuthError(
    messages[status] ?? "Cloud read failed. Try again later.",
  );
}
function resultBody(kind: Kind, body: unknown): Record<string, unknown> {
  const parsed = { stats, show: summary, history, list: page }[kind].safeParse(
    body,
  );
  if (!parsed.success)
    throw new AuthError("Cloud returned an invalid read response.");
  return parsed.data;
}
function humanRow(value: unknown): string {
  const item = value as Record<string, unknown>;
  const fields = [
    "id",
    "test_id",
    "description",
    "started_at",
    "branch",
    "state",
    "verdict",
    "observation_count",
    "failed_count",
    "failure_rate",
    "retry_count",
    "elapsed_ms",
    "recovered_retry_count",
    "recovered_retry_rate",
    "retry_elapsed_ms",
    "p95_elapsed_ms",
    "p95_change_ms",
    "p95_change_ratio",
  ];
  const text = fields
    .filter((key) => item[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(item[key])}`)
    .join("  ");
  const tests = Array.isArray(item.tests)
    ? item.tests.map(humanRow).join("; ")
    : "";
  return tests ? `${text}  tests=[${tests}]` : text;
}
function human(scope: string, result: Record<string, unknown>): string {
  const { data, report, ...metadata } = result;
  const rows = Array.isArray(data) ? data : [];
  const lines = [scope, JSON.stringify(metadata, null, 2)];
  if (Array.isArray(data))
    lines.push(`Rows: ${rows.length}`, ...rows.map(humanRow));
  if (report !== undefined) lines.push(JSON.stringify(report, null, 2));
  if (typeof result.next_cursor === "string")
    lines.push(
      `Continue with --cursor ${JSON.stringify(result.next_cursor)} (reuse the same --since/--until and filters).`,
    );
  return lines.join("\n") + "\n";
}
interface Runtime {
  auth?: AuthRuntime;
  signal?: AbortSignal;
}
interface Output {
  rawOut: (value: string) => void;
  writeErr: (value: string) => void;
  setExitCode: (value: number) => void;
}
function publish(
  result: Record<string, unknown>,
  scope: {
    origin: string;
    organization: { id: string; name: string };
    project: { id: string; name: string };
  },
  options: Options,
  output: Output,
): void {
  if (!options.report) delete result.report;
  if (options.json)
    output.rawOut(
      JSON.stringify({ ...result, schemaVersion: 1, ...scope }) + "\n",
    );
  else
    output.rawOut(
      human(
        `${JSON.stringify(scope.organization.name)} / ${JSON.stringify(scope.project.name)}`,
        result,
      ),
    );
}
function readRoute(kind: Kind, runId: unknown): string {
  if (kind === "show") {
    if (!z.uuid().safeParse(runId).success)
      throw new AuthError("Run ID must be a Cloud run UUID.");
    return `runs/${encodeURIComponent(String(runId))}`;
  }
  return kind === "list" ? "runs" : `tests/${kind}`;
}
function queryOptions(command: Command, kind: Kind): void {
  command
    .option("--since <time>", "positive Nd/Nh or ISO timestamp", "7d")
    .option("--until <time>", "ISO timestamp; defaults to now")
    .option("--branch <branch>")
    .option("--commit-sha <sha>", "40 or 64 lowercase hexadecimal characters")
    .option("--state <state>", "completed, interrupted, error")
    .option("--verdict <verdict>", "passed, failed")
    .option("--limit <count>", "maximum results (1..100)", "25");
  if (kind !== "stats") command.option("--cursor <cursor>", "one page only");
  if (kind !== "list")
    command.option("--test-id <exact-id>", "exact test ID, across branches");
  if (kind === "stats")
    command
      .option("--sort <metric>", sorts.join(", "))
      .option(
        "--min-observations <count>",
        "minimum observations (1..1000)",
        "1",
      )
      .option("--compare <period>", "previous equal-length period");
}
async function execute(
  input: { kind: Kind; runId: unknown; options: Options },
  runtime: Runtime,
  output: Output,
): Promise<void> {
  const { kind, runId, options } = input;
  try {
    const params = filters(kind, options);
    const route = readRoute(kind, runId);
    const { readCloudProject } = await import("./auth-command.js");
    await readCloudProject(
      options,
      runtime.auth ?? {},
      runtime.signal ?? new AbortController().signal,
      async ({ origin, organization, project, get }) => {
        const response = await get(
          `/api/projects/${encodeURIComponent(project.id)}/${route}?${params}`,
        );
        if (kind === "show" && response.status === 404)
          throw new AuthError(
            "Run not found in this project. `runs show` takes the Cloud run UUID that the upload printed (`id` in `runs list`), not the local run ID.",
          );
        if (!response.ok) throw statusError(response.status);
        const result = resultBody(kind, response.body);
        publish(
          result,
          {
            origin,
            organization: { id: organization.id, name: organization.name },
            project,
          },
          options,
          output,
        );
      },
    );
    output.setExitCode(0);
  } catch (error) {
    output.writeErr(
      (error instanceof AuthError
        ? error.message
        : "Cloud read failed safely; no server details were printed.") + "\n",
    );
    output.setExitCode(3);
  }
}
export function registerCloudCommands(
  program: Command,
  runtime: Runtime,
  output: Output,
): void {
  const runs = program.command("runs").description("read Cloud runs");
  const tests = program
    .command("tests")
    .description("read Cloud test history and ranked statistics");
  for (const [parent, kind] of [
    [runs, "list"],
    [runs, "show"],
    [tests, "history"],
    [tests, "stats"],
  ] as const) {
    const command = parent
      .command(kind === "show" ? "show <run-id>" : kind)
      .description(`Cloud ${kind}`)
      .option("--json", "versioned machine-readable output")
      .option("--url <origin>", "Cloud origin")
      .option(
        "--organization <id-or-name>",
        "organization ID or unambiguous name",
      )
      .option("--project <id-or-name>", "project ID or unambiguous name");
    if (kind === "show") command.option("--report", "include the full report");
    else queryOptions(command, kind);
    command.action(async (...args: unknown[]) =>
      execute(
        { kind, runId: args[0], options: command.opts<Options>() },
        runtime,
        output,
      ),
    );
  }
}
