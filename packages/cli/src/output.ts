import { validateRunResult, type RunResult } from "@sedum-dev/core";
import { usageLines, visionSummary } from "@sedum-dev/reporters";

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
  const current = value.tests.at(-1)?.file ?? "preparing run";
  return `\r\u001b[2K${paint("RUNNING", "cyan", capabilities.color)} ${current}`;
}

export function clearProgress(capabilities: OutputCapabilities): string {
  return capabilities.stdoutIsTTY ? "\r\u001b[2K" : "";
}

/** Parallel, shard, provider-wait, and cache-conflict facts; empty for a plain serial run. */
function executionLines(value: RunResult): string[] {
  const lines: string[] = [];
  const execution = value.execution;
  if (execution && (execution.parallel.lanes > 1 || execution.shard)) {
    const shard = execution.shard
      ? `, shard ${execution.shard.index}/${execution.shard.count} of ${execution.shard.globalSelectedTests} selected`
      : "";
    lines.push(
      `lanes ${execution.parallel.lanes}, provider concurrency ${execution.providerConcurrency}${shard}`,
    );
  }
  const calls = [
    ...value.setupCalls,
    ...value.tests.flatMap((test) =>
      test.attempts.flatMap((attempt) => [
        ...(attempt.calls ?? []),
        ...attempt.steps.flatMap((step) => step.calls),
      ]),
    ),
  ];
  if (execution?.vision) {
    const steps = value.tests.flatMap((test) =>
      test.attempts.flatMap((attempt) => attempt.steps),
    );
    const used = steps.filter((step) => step.locator?.vision).length;
    lines.push(
      used
        ? `vision ${execution.vision.model}: used on ${used} step(s)`
        : `vision ${execution.vision.model}: enabled, not used; it only breaks ties between repeated controls the text model finds ambiguous`,
    );
    if (execution.vision.key === "rejected")
      lines.push(
        "vision warning: OpenRouter rejected OPEN_ROUTER_API_KEY, so vision fallback cannot work. Check it with `sedum doctor --vision`.",
      );
    else if (execution.vision.key === "unreachable")
      lines.push(
        "vision warning: OpenRouter could not be reached to check OPEN_ROUTER_API_KEY.",
      );
  }
  const limited = calls.filter((call) => call.rateLimited).length;
  const waitMs = calls.reduce(
    (sum, call) => sum + (call.rateLimitWaitMs ?? 0),
    0,
  );
  if (limited > 0)
    lines.push(
      `provider rate limited ${limited} call(s), waited ${(waitMs / 1000).toFixed(1)}s in shared cooldowns`,
    );
  const conflicts = value.tests
    .flatMap((test) => test.attempts)
    .flatMap((attempt) => attempt.steps)
    .filter((step) => step.locator?.cache?.reason === "conflict").length;
  if (conflicts > 0)
    lines.push(
      `cache ${conflicts} locator cache write conflict(s); the model result was used`,
    );
  return lines;
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
  for (const test of value.tests) {
    const label = stateLabel(test.state, test.verdict);
    const flags = test.flags.length ? ` [${test.flags.join(", ")}]` : "";
    lines.push(
      `test ${paint(label.text, label.color, color)} ${test.file}${flags}`,
    );
    if (test.attempts.length > 1)
      lines.push(
        `  attempts ${test.attempts.length} (${test.attempts.map((attempt) => attempt.verdict ?? attempt.state).join(" -> ")})`,
      );
    const selected = test.attempts.find(
      (attempt) => attempt.id === test.selectedAttemptId,
    );
    for (const step of selected?.steps ?? []) {
      for (const flag of step.flags) flagCounts[flag] += 1;
      const cache = step.locator?.cache;
      if (cache) {
        const reason = cache.reason ? ` (${cache.reason})` : "";
        const fallback = cache.fallbackCalledModel ? ", model fallback" : "";
        const changed = cache.targetChanged ? ", target changed" : "";
        lines.push(
          `  step ${step.index}: cache ${cache.outcome}${reason}${fallback}${changed}`,
        );
      }
    }
  }
  const runLabel = stateLabel(value.state, value.verdict);
  lines.push(`run  ${paint(runLabel.text, runLabel.color, color)}`);
  for (const problem of value.discoveryProblems ?? [])
    lines.push(
      `discovery ${problem.file}${problem.line === undefined ? "" : `:${problem.line}:${problem.col ?? 1}`}: ${problem.message} Fix: ${problem.fix}`,
    );
  const erroredTests = value.tests.filter(
    (test) => test.state === "error",
  ).length;
  lines.push(
    `tests ${value.totals.selectedTests} selected, ${value.totals.executedTests} executed, ${value.totals.passedTests} passed, ${value.totals.failedTests} failed${erroredTests ? `, ${erroredTests} could not run` : ""}`,
  );
  lines.push(
    `flags ${value.totals.flaggedSteps} flagged step(s), low_confidence ${flagCounts.low_confidence}, contradiction ${flagCounts.contradiction}`,
  );
  lines.push(...executionLines(value));
  for (const test of value.tests)
    for (const attempt of test.attempts)
      for (const step of attempt.steps) {
        const vision = visionSummary(step);
        if (vision)
          lines.push(
            `${test.file} · attempt ${attempt.ordinal} · step ${step.index}: ${vision}`.replace(
              // Strip terminal control characters from provider metadata.
              // eslint-disable-next-line no-control-regex
              /[\u0000-\u001f\u007f-\u009f]/g,
              " ",
            ),
          );
      }
  if (artifacts.authoritative) {
    lines.push(`progress ${artifacts.progressPath}`);
    lines.push(`result ${artifacts.resultPath}`);
    if (artifacts.htmlPath) lines.push(`html ${artifacts.htmlPath}`);
    if (artifacts.markdownPath)
      lines.push(`markdown ${artifacts.markdownPath}`);
    if (artifacts.junitPath) lines.push(`junit ${artifacts.junitPath}`);
    if (artifacts.reporterPath)
      lines.push(`reporter ${artifacts.reporterPath}`);
  } else {
    lines.push(`result unavailable (intended ${artifacts.resultPath})`);
  }
  if (capabilities.stdoutIsTTY || showCosts) {
    lines.push(...usageLines(value));
    lines.push(
      `model ${value.totals.modelCalls} call(s), ${value.totals.inputTokens} input tokens, ${value.totals.outputTokens} output tokens`,
    );
    lines.push(
      value.totals.costComplete && value.totals.costUsd !== null
        ? `cost $${value.totals.costUsd.toFixed(6)}`
        : "cost unknown or incomplete",
    );
  }
  return `${lines.join("\n")}\n`;
}
