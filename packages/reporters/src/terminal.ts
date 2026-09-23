import type { RunResult } from "@sedum-dev/core";
import path from "node:path";
import type { ReporterEvent } from "./lifecycle.js";
import { needsAttention, selectedAttempt, shellArg } from "./shared.js";

export type TerminalReporterName = "list" | "steps";

export interface ReporterContext {
  readonly stdoutIsTTY: boolean;
  readonly color: boolean;
  readonly showCosts: boolean;
  readonly progressPath: string;
  readonly resultPath: string;
  readonly authoritative: boolean;
  readonly includeSharedSummary: boolean;
  readonly rerunFile?: string;
}

export interface Reporter {
  onEvent(event: ReporterEvent, context: ReporterContext): string;
  onResult(result: RunResult, context: ReporterContext): string;
}

function label(state: string, verdict: string | null): string {
  return verdict === "passed"
    ? "PASSED"
    : verdict === "failed"
      ? "FAILED"
      : state.toUpperCase();
}

function coloredLabel(
  state: string,
  verdict: string | null,
  context: ReporterContext,
): string {
  const text = label(state, verdict);
  if (!context.stdoutIsTTY || !context.color) return text;
  const color =
    verdict === "passed"
      ? 32
      : verdict === "failed" || state === "error"
        ? 31
        : 36;
  return `\u001b[${color}m${text}\u001b[0m`;
}

function flags(value: readonly string[]): string {
  return value.length ? ` [${value.join(", ")}]` : "";
}

function source(
  stack: readonly { file: string; line: number; col: number }[],
): string {
  return stack.map((item) => `${item.file}:${item.line}`).join(" <- ");
}

function attention(result: RunResult, context: ReporterContext): string {
  const lines: string[] = [];
  const reruns = new Set<string>();
  const evidence = new Set<string>();
  for (const test of result.tests) {
    const attempt = selectedAttempt(test);
    if (!attempt) continue;
    const affectedSteps = attempt.steps.filter(needsAttention);
    const bindingProblems = attempt.problems.filter(
      (problem) => problem.stepId === null,
    );
    if (
      affectedSteps.length === 0 &&
      bindingProblems.length === 0 &&
      !attempt.error
    )
      continue;
    reruns.add(test.file);
    lines.push(`\nneeds attention: ${test.file}`);
    for (const step of affectedSteps) {
      lines.push(
        `  ${label(step.state, step.verdict)}${flags(step.flags)} ${step.phase} step ${step.index}: ${step.sentence}`,
      );
      lines.push(`    at ${source(step.sourceStack)}`);
      if (step.detail) lines.push(`    result ${step.detail}`);
      const linkedProblems = attempt.problems.filter(
        (problem) => problem.stepId === step.id,
      );
      if (linkedProblems.length)
        for (const problem of linkedProblems)
          lines.push(
            `    error ${problem.error.code}: ${problem.error.message}`,
          );
      else if (step.error)
        lines.push(`    error ${step.error.code}: ${step.error.message}`);
      if (step.judgement) {
        const j = step.judgement;
        lines.push(
          `    judged holds ${j.holds}, contradicted ${j.contradicted}, threshold ${j.threshold ?? "n/a"}, band ${j.band ?? "n/a"}, contradiction cutoff ${j.contradictionCutoff ?? "n/a"}`,
        );
        if (j.threshold !== null && j.band !== null)
          lines.push(`    fails below ${j.threshold - j.band}`);
        if (j.judgedExcerpt) lines.push(`    excerpt ${j.judgedExcerpt}`);
      }
      if (step.locator) {
        lines.push(
          `    locator ${step.locator.source}, confidence ${step.locator.confidence ?? "n/a"}`,
        );
        for (const option of step.locator.options)
          lines.push(
            `      ${option.label}${option.role ? ` (${option.role})` : ""}: ${option.probability}`,
          );
      }
      if (step.page.status === "available")
        lines.push(`    page ${step.page.url} "${step.page.title}"`);
      else lines.push(`    page ${step.page.status}: ${step.page.reason}`);
      if (step.evidence.status === "captured") {
        const framePath = context.authoritative
          ? path.join(path.dirname(context.resultPath), step.evidence.path)
          : step.evidence.path;
        lines.push(`    frame ${framePath}`);
        if (context.authoritative) evidence.add(framePath);
      } else
        lines.push(
          `    frame ${step.evidence.status}: ${step.evidence.reason}`,
        );
    }
    for (const problem of bindingProblems) {
      lines.push(
        `  ${problem.outcome.toUpperCase()} ${problem.phase} module binding`,
      );
      lines.push(`    at ${source(problem.sourceStack)}`);
      lines.push(`    error ${problem.error.code}: ${problem.error.message}`);
    }
    if (attempt.error)
      lines.push(
        `  test error ${attempt.error.code}: ${attempt.error.message}`,
      );
  }
  if (
    reruns.size > 0 ||
    result.state === "error" ||
    result.state === "interrupted"
  ) {
    lines.push("\nnext");
    if (context.authoritative) {
      lines.push(`  read ${context.resultPath}`);
      lines.push(`  read ${context.progressPath}`);
      for (const path of evidence) lines.push(`  read ${path}`);
    } else lines.push(`  result unavailable (intended ${context.resultPath})`);
    for (const file of reruns)
      lines.push(`  rerun sedum run ${shellArg(file)}`);
    if (reruns.size === 0)
      lines.push(
        context.rerunFile
          ? `  rerun sedum run ${shellArg(context.rerunFile)}`
          : "  rerun sedum run",
      );
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function createTerminalReporter(name: TerminalReporterName): Reporter {
  return {
    onEvent(event, context) {
      if (event.type === "runStarted")
        return context.authoritative
          ? `progress ${context.progressPath}\n`
          : "";
      if (event.type === "testStarted" && name === "list")
        return `test ${coloredLabel("running", null, context)} ${event.test.file}\n`;
      if (event.type === "stepCompleted" && name === "steps") {
        const { step, test } = event;
        return `${test.file}:${step.sourceStack[0]?.line ?? 1} ${coloredLabel(step.state, step.verdict, context)}${flags(step.flags)} ${step.phase} step ${step.index}: ${step.sentence}\n`;
      }
      if (event.type === "testCompleted" && name === "list")
        return `test ${coloredLabel(event.test.state, event.test.verdict, context)}${flags(event.test.flags)} ${event.test.file}\n`;
      return "";
    },
    onResult(result, context) {
      return context.includeSharedSummary ? attention(result, context) : "";
    },
  };
}
