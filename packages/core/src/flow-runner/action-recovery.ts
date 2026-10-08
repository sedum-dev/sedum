import { setTimeout as delay } from "node:timers/promises";
import { StepExecutionError, type StepOperation } from "../step-executor.js";
import type { LocatorOptionDiagnostic, LocatorResult } from "../locator.js";
import type { BrowserPage } from "../browser-driver.js";
import { quietPage } from "../page-bridge.js";

export async function refreshAfterQuiet(
  page: BrowserPage,
  remainingMs: number,
  signal: AbortSignal,
  locate: (signal: AbortSignal, timeoutMs: number) => Promise<LocatorResult>,
): Promise<LocatorResult | undefined> {
  const deadline = performance.now() + remainingMs;
  const quiet = await quietPage(page, 80, Math.min(4_000, remainingMs)).catch(
    () => ({ quiet: false }),
  );
  if (!quiet.quiet) return undefined;
  if (signal.aborted || performance.now() >= deadline) return undefined;
  return locate(signal, deadline - performance.now());
}

function isNoMatch(option?: LocatorOptionDiagnostic): boolean {
  return option?.name === "(no match)" && option.role === "";
}

/** A no-match runner-up is evidence that the requested page may not be ready,
 * not permission to weaken the locator's acceptance threshold. */
export function pendingTarget(result: LocatorResult): boolean {
  if (result.kind === "resolved") return false;
  if (["none", "no_candidates"].includes(result.reason)) return true;
  const [first, second] = result.diagnostic.topOptions;
  return (
    result.reason === "ambiguous" &&
    result.diagnostic.gate === "low_confidence_or_margin" &&
    isNoMatch(second) &&
    (first?.probability ?? 1) - second!.probability < 0.2
  );
}

interface ActionRecovery {
  readonly op: StepOperation;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly perform: (remainingMs: number) => Promise<unknown>;
  readonly refresh: (
    remainingMs: number,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly allowed: () => boolean;
}

/** Retry only refusals that prove no input was dispatched. Resolution has its
 * own budget; all readiness waits and re-resolutions share this action budget. */
export async function performWithRecovery(
  options: ActionRecovery,
): Promise<void> {
  await new ActionAttempts(options).run();
}

class ActionAttempts {
  private readonly started = performance.now();
  private readonly deadline: number;
  private readonly signal: AbortSignal;
  private last: StepExecutionError;
  private attempts = 0;

  constructor(private readonly options: ActionRecovery) {
    const budget = options.timeoutMs ?? 8_000;
    this.deadline = this.started + budget;
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(budget)));
    this.signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    this.last = new StepExecutionError(options.op, "timeout", "pre_dispatch");
  }

  private remaining(): number {
    return this.signal.aborted
      ? 0
      : Math.max(0, this.deadline - performance.now());
  }

  async run(): Promise<void> {
    while (this.remaining() > 0) {
      if (!(await this.prepareRetry())) continue;
      if (this.remaining() <= 0) break;
      if (await this.perform()) return;
    }
    throw this.exhausted();
  }

  private async prepareRetry(): Promise<boolean> {
    if (this.attempts === 0) return true;
    if (!this.options.allowed()) throw this.last;
    await this.pause();
    if (this.remaining() <= 0) return false;
    if (this.last.code !== "stale") return true;
    return this.refresh();
  }

  private async refresh(): Promise<boolean> {
    const refreshed = await this.options.refresh(this.remaining(), this.signal);
    if (!refreshed && this.options.op !== "click") throw this.last;
    return refreshed;
  }

  private async pause(): Promise<void> {
    await delay(Math.min(100, this.remaining()), undefined, {
      signal: this.signal,
    }).catch(() => undefined);
  }

  private retryable(error: unknown): error is StepExecutionError {
    if (!(error instanceof StepExecutionError)) return false;
    if (!error.retryable || !this.options.allowed()) return false;
    if (this.options.op !== "click")
      return this.attempts === 0 && error.code === "stale";
    return ["stale", "not_actionable"].includes(error.code);
  }

  private async perform(): Promise<boolean> {
    try {
      await this.options.perform(this.remaining());
      return true;
    } catch (error) {
      if (!this.retryable(error)) throw error;
      this.last = error;
      this.attempts++;
      return false;
    }
  }

  private exhausted(): StepExecutionError {
    if (this.options.signal?.aborted)
      return new StepExecutionError(
        this.options.op,
        "canceled",
        "pre_dispatch",
      );
    return this.refusalAfterWait();
  }

  private refusalAfterWait(): StepExecutionError {
    const op = this.options.op;
    const waitedMs = Math.round(performance.now() - this.started);
    return new StepExecutionError(
      op,
      this.last.code,
      "pre_dispatch",
      [
        ...this.last.callLog,
        `Waited ${waitedMs} ms for a ready target; no input dispatched.`,
      ],
      `${op} failed: ${this.last.code} after waiting ${waitedMs} ms for a ready target.`,
    );
  }
}
