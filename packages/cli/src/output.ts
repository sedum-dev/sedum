import { validateRunResult, type RunResult } from "@sedum-dev/core";

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
  lines.push(
    `tests ${value.totals.selectedTests} selected, ${value.totals.executedTests} executed, ${value.totals.passedTests} passed, ${value.totals.failedTests} failed`,
  );
  lines.push(
    `flags ${value.totals.flaggedSteps} flagged step(s), low_confidence ${flagCounts.low_confidence}, contradiction ${flagCounts.contradiction}`,
  );
  if (artifacts.authoritative) {
    lines.push(`progress ${artifacts.progressPath}`);
    lines.push(`result ${artifacts.resultPath}`);
    if (artifacts.htmlPath) lines.push(`html ${artifacts.htmlPath}`);
    if (artifacts.markdownPath)
      lines.push(`markdown ${artifacts.markdownPath}`);
    if (artifacts.reporterPath)
      lines.push(`reporter ${artifacts.reporterPath}`);
  } else {
    lines.push(`result unavailable (intended ${artifacts.resultPath})`);
  }
  if (capabilities.stdoutIsTTY || showCosts) {
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
