import { validateRunResult, type RunResult } from "@sedum-dev/core";
import { testLabel, usageLines, visionSummary } from "@sedum-dev/reporters";

export interface OutputCapabilities {
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly color: boolean;
  readonly columns?: number;
}

export interface RunArtifactPaths {
  readonly progressPath: string;
  readonly resultPath: string;
  readonly htmlPath?: string | undefined;
  readonly markdownPath?: string | undefined;
  readonly junitPath?: string | undefined;
  readonly reporterPath?: string;
  readonly authoritative: boolean;
}

const ansi = {
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  reset: "\u001b[0m",
};

function paint(
  value: string,
  color: keyof Omit<typeof ansi, "reset">,
  enabled: boolean,
): string {
  return enabled ? `${ansi[color]}${value}${ansi.reset}` : value;
}

function stateLabel(
  state: RunResult["state"] | RunResult["tests"][number]["state"],
  verdict: "passed" | "failed" | null,
): { text: string; color: "green" | "red" | "yellow" } {
  if (verdict === "passed") return { text: "PASSED", color: "green" };
  if (verdict === "failed") return { text: "FAILED", color: "red" };
  if (state === "interrupted") return { text: "INTERRUPTED", color: "yellow" };
  if (state === "running") return { text: "INCOMPLETE", color: "yellow" };
  return { text: "ERROR", color: "red" };
}

export function renderProgress(
  result: RunResult,
  capabilities: OutputCapabilities,
): string {
  if (!capabilities.stdoutIsTTY) return "";
  const value = validateRunResult(result);
  const last = value.tests.at(-1);
  const current = last ? testLabel(last) : "preparing run";
  return `\r\u001b[2K${paint("RUNNING", "cyan", capabilities.color)} ${current}`;
}

export function clearProgress(capabilities: OutputCapabilities): string {
  return capabilities.stdoutIsTTY ? "\r\u001b[2K" : "";
}

type ResultTest = RunResult["tests"][number];
type ResultStep = ResultTest["attempts"][number]["steps"][number];
type FlagCounts = Record<ResultStep["flags"][number], number>;
type VisionAttempt = NonNullable<NonNullable<ResultStep["locator"]>["vision"]>;

function compact(lines: readonly (string | null)[]): string[] {
  return lines.filter((line): line is string => line !== null);
}

function resultSteps(value: RunResult): ResultStep[] {
  return value.tests.flatMap((test) =>
    test.attempts.flatMap((attempt) => attempt.steps),
  );
}

function resultCalls(value: RunResult) {
  return [
    ...value.setupCalls,
    ...value.tests.flatMap((test) =>
      test.attempts.flatMap((attempt) => [
        ...(attempt.calls ?? []),
        ...attempt.steps.flatMap((step) => step.calls),
      ]),
    ),
  ];
}

function executionPlanLine(value: RunResult): string | null {
  const execution = value.execution;
  if (!execution || (execution.parallel.lanes <= 1 && !execution.shard))
    return null;
  const shard = execution.shard
    ? `, shard ${execution.shard.index}/${execution.shard.count} of ${execution.shard.globalSelectedTests} selected`
    : "";
  return `lanes ${execution.parallel.lanes}, provider concurrency ${execution.providerConcurrency}${shard}`;
}

function visionOutcomeLine(
  model: string,
  attempts: readonly VisionAttempt[],
): string {
  if (attempts.length === 0)
    return `vision ${model}: enabled, no fallback attempted`;
  const selected = attempts.filter(
    (attempt) => attempt.outcome === "selected",
  ).length;
  const abstained = attempts.filter(
    (attempt) => attempt.outcome === "abstained",
  ).length;
  const failed = attempts.filter(
    (attempt) =>
      attempt.outcome === "failed" || (!attempt.outcome && attempt.failure),
  ).length;
  const unrecorded = attempts.length - selected - abstained - failed;
  const unrecordedText = unrecorded ? `, ${unrecorded} outcome unrecorded` : "";
  return `vision ${model}: attempted on ${attempts.length} step(s); ${selected} selected, ${abstained} abstained, ${failed} failed${unrecordedText}`;
}

function failedClickVisionLine(steps: readonly ResultStep[]): string | null {
  const failedClicks = steps.filter(
    (step) =>
      step.operation === "click" &&
      (step.verdict === "failed" || step.state === "error") &&
      !step.locator?.vision,
  ).length;
  return failedClicks
    ? `vision not attempted on ${failedClicks} failed click step(s); see step errors for details`
    : null;
}

function visionExecutionLines(
  value: RunResult,
  steps: readonly ResultStep[],
): string[] {
  const vision = value.execution?.vision;
  if (!vision) return [];
  const attempts = steps.flatMap((step) =>
    step.locator?.vision ? [step.locator.vision] : [],
  );
  const warnings = {
    accepted: null,
    rejected:
      "vision warning: OpenRouter rejected OPEN_ROUTER_API_KEY, so vision fallback cannot work. Check it with `sedum doctor --vision`.",
    unreachable:
      "vision warning: OpenRouter could not be reached to check OPEN_ROUTER_API_KEY.",
  } as const;
  return compact([
    visionOutcomeLine(vision.model, attempts),
    failedClickVisionLine(steps),
    warnings[vision.key],
  ]);
}

function rateLimitLine(value: RunResult): string | null {
  const calls = resultCalls(value);
  const limited = calls.filter((call) => call.rateLimited).length;
  if (limited === 0) return null;
  const waitMs = calls.reduce(
    (sum, call) => sum + (call.rateLimitWaitMs ?? 0),
    0,
  );
  return `provider rate limited ${limited} call(s), waited ${(waitMs / 1000).toFixed(1)}s in shared cooldowns`;
}

function cacheConflictLine(steps: readonly ResultStep[]): string | null {
  const conflicts = steps.filter(
    (step) => step.locator?.cache?.reason === "conflict",
  ).length;
  return conflicts > 0
    ? `cache ${conflicts} locator cache write conflict(s); the model result was used`
    : null;
}

/** Parallel, shard, provider-wait, and cache-conflict facts; empty for a plain serial run. */
function executionLines(value: RunResult): string[] {
  const steps = resultSteps(value);
  return [
    ...compact([executionPlanLine(value)]),
    ...visionExecutionLines(value, steps),
    ...compact([rateLimitLine(value), cacheConflictLine(steps)]),
  ];
}

function cacheLine(step: ResultStep): string | null {
  const cache = step.locator?.cache;
  if (!cache) return null;
  const reason = cache.reason ? ` (${cache.reason})` : "";
  const fallback = cache.fallbackCalledModel ? ", model fallback" : "";
  const changed = cache.targetChanged ? ", target changed" : "";
  return `  step ${step.index}: cache ${cache.outcome}${reason}${fallback}${changed}`;
}

function testDetailLines(test: ResultTest, flagCounts: FlagCounts): string[] {
  const retry =
    test.attempts.length > 1
      ? `  attempts ${test.attempts.length} (${test.attempts.map((attempt) => attempt.verdict ?? attempt.state).join(" -> ")})`
      : null;
  const selected = test.attempts.find(
    (attempt) => attempt.id === test.selectedAttemptId,
  );
  const caches = (selected?.steps ?? []).flatMap((step) => {
    for (const flag of step.flags) flagCounts[flag] += 1;
    const line = cacheLine(step);
    return line ? [line] : [];
  });
  const details = [...compact([retry]), ...caches];
  return details.length ? [testLabel(test), ...details] : [];
}

function hasOutsideGitStep(value: RunResult): boolean {
  return resultSteps(value).some(
    (step) => step.locator?.cache?.reason === "outside_git",
  );
}

function discoveryLine(
  problem: NonNullable<RunResult["discoveryProblems"]>[number],
): string {
  const location =
    problem.line === undefined ? "" : `:${problem.line}:${problem.col ?? 1}`;
  return `discovery ${problem.file}${location}: ${problem.message} Fix: ${problem.fix}`;
}

function testCountLine(value: RunResult): string {
  const errored = value.tests.filter((test) => test.state === "error").length;
  const errorCount = errored ? `, ${errored} could not run` : "";
  return `tests ${value.totals.selectedTests} selected, ${value.totals.executedTests} executed, ${value.totals.passedTests} passed, ${value.totals.failedTests} failed${errorCount}`;
}

function flagCountLine(value: RunResult, counts: FlagCounts): string {
  const flaky = value.tests.filter((test) =>
    test.flags.includes("flaky"),
  ).length;
  return `flags ${value.totals.flaggedSteps} flagged step(s), low_confidence ${counts.low_confidence}, contradiction ${counts.contradiction}, flaky ${flaky} test(s)`;
}

function visionDetailLines(value: RunResult): string[] {
  return value.tests.flatMap((test) =>
    test.attempts.flatMap((attempt) =>
      attempt.steps.flatMap((step) => {
        const vision = visionSummary(step);
        if (!vision) return [];
        return [
          `${test.file} · attempt ${attempt.ordinal} · step ${step.index}: ${vision}`.replace(
            // Strip terminal control characters from provider metadata.
            // eslint-disable-next-line no-control-regex
            /[\u0000-\u001f\u007f-\u009f]/g,
            " ",
          ),
        ];
      }),
    ),
  );
}

function artifactLines(artifacts: RunArtifactPaths): string[] {
  if (!artifacts.authoritative)
    return [`result unavailable (intended ${artifacts.resultPath})`];
  return compact([
    `result ${artifacts.resultPath}`,
    artifacts.htmlPath ? `html ${artifacts.htmlPath}` : null,
    artifacts.markdownPath ? `markdown ${artifacts.markdownPath}` : null,
    artifacts.junitPath ? `junit ${artifacts.junitPath}` : null,
    artifacts.reporterPath ? `reporter ${artifacts.reporterPath}` : null,
  ]);
}

function costLines(value: RunResult): string[] {
  const unknown =
    !value.totals.costComplete || value.totals.costUsd === null
      ? "cost unknown or incomplete"
      : null;
  return [...usageLines(value), ...compact([unknown])];
}

export function renderRunSummary(
  result: RunResult,
  capabilities: OutputCapabilities,
  artifacts: RunArtifactPaths,
  showCosts: boolean,
): string {
  const value = validateRunResult(result);
  const color = capabilities.stdoutIsTTY && capabilities.color;
  const lines: string[] = [];
  const flagCounts = { low_confidence: 0, contradiction: 0 };
  // The live reporter has already printed each test's outcome; the summary
  // only adds the detail it did not show, under the test's file.
  for (const test of value.tests)
    lines.push(...testDetailLines(test, flagCounts));
  if (hasOutsideGitStep(value))
    lines.push(
      "cache off: this project is not a Git checkout; run `git init` to cache locator results",
    );
  const runLabel = stateLabel(value.state, value.verdict);
  lines.push(`run  ${paint(runLabel.text, runLabel.color, color)}`);
  for (const problem of value.discoveryProblems ?? [])
    lines.push(discoveryLine(problem));
  lines.push(testCountLine(value), flagCountLine(value, flagCounts));
  lines.push(...executionLines(value));
  lines.push(...visionDetailLines(value), ...artifactLines(artifacts));
  if (capabilities.stdoutIsTTY || showCosts) lines.push(...costLines(value));
  return `${lines.join("\n")}\n`;
}
