import { inspect } from "node:util";
import type { BrowserPage } from "./browser-driver.js";
import { clickTarget, pageVersion, quietPage } from "./page-bridge.js";
import type { Aim, FillTarget, PageVersion } from "./page-protocol.js";
import { safeCallLog } from "./safe-diagnostics.js";

/** A runtime substitution is never printed or serialized by the executor. */
export class RuntimeValue {
  readonly #value: string;
  readonly display: string;

  constructor(value: string, display = "[runtime value]") {
    if (
      display !== "[runtime value]" &&
      !/^\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}$/.test(display)
    )
      throw new RangeError("Runtime value display must be a placeholder name");
    this.#value = value;
    this.display = display;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return this.display;
  }

  toJSON(): string {
    return this.display;
  }

  [inspect.custom](): string {
    return this.display;
  }
}

/** Literal URL pieces and opaque substitutions keep the display URL safe. */
export class RuntimeUrl {
  readonly #literals: readonly string[];
  readonly #values: readonly RuntimeValue[];

  constructor(
    literals: readonly string[],
    values: readonly RuntimeValue[] = [],
  ) {
    if (literals.length !== values.length + 1)
      throw new RangeError("Runtime URL pieces do not match");
    this.#literals = [...literals];
    this.#values = [...values];
  }

  reveal(): string {
    return this.#literals.reduce(
      (url, literal, index) =>
        url + (index ? this.#values[index - 1]!.reveal() : "") + literal,
      "",
    );
  }

  toString(): string {
    return this.#literals.reduce(
      (url, literal, index) =>
        url + (index ? this.#values[index - 1]!.toString() : "") + literal,
      "",
    );
  }

  toJSON(): string {
    return this.toString();
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** The route-bearing snapshot target is not part of public diagnostics. */
export class ResolvedStepTarget {
  readonly #target: FillTarget;

  constructor(target: FillTarget) {
    this.#target = Object.freeze({
      ...target,
      version: Object.freeze({ ...target.version }),
    });
  }

  /** Only the executor/driver path should use the route-bearing snapshot. */
  driverTarget(): FillTarget {
    return this.#target;
  }

  toJSON(): object {
    return { ref: this.#target.ref };
  }

  [inspect.custom](): string {
    return `ResolvedStepTarget(${this.#target.ref})`;
  }
}

export type StepCommand =
  | {
      readonly op: "click";
      readonly target: ResolvedStepTarget;
    }
  | {
      readonly op: "type";
      readonly target: ResolvedStepTarget;
      readonly value: RuntimeValue;
    }
  | { readonly op: "press"; readonly key: string }
  | { readonly op: "goto"; readonly url: RuntimeUrl }
  | { readonly op: "scroll"; readonly deltaY: number }
  | { readonly op: "wait"; readonly durationMs: number };

export type StepOperation = StepCommand["op"];
export type StepOutcome = "acted" | "route_changed" | "no_route_change";
export interface StepExecutionResult {
  readonly op: StepOperation;
  readonly outcome: StepOutcome;
  readonly elapsedMs: number;
  readonly displayUrl?: string;
}

export type StepFailureCode =
  | "invalid_input"
  | "canceled"
  | "timeout"
  | "stale"
  | "not_actionable"
  | "action_uncertain"
  | "operation_failed";
export type StepFailurePhase = "pre_dispatch" | "post_dispatch";

export class StepExecutionError extends Error {
  readonly op: StepOperation;
  readonly code: StepFailureCode;
  readonly phase: StepFailurePhase;
  readonly retryable: boolean;
  readonly callLog: readonly string[];

  constructor(
    op: StepOperation,
    code: StepFailureCode,
    phase: StepFailurePhase,
    callLog: readonly string[] = [],
  ) {
    super(`${op} failed: ${code}`);
    this.name = "StepExecutionError";
    this.op = op;
    this.code = code;
    this.phase = phase;
    this.retryable = phase === "pre_dispatch";
    this.callLog = callLog;
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      op: this.op,
      code: this.code,
      phase: this.phase,
      retryable: this.retryable,
      callLog: this.callLog,
    };
  }
}

export interface StepExecutionOptions {
  /** A caller-supplied whole-step budget, including post-action observation. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Diagnostic capture after final aim/scroll and before event dispatch. */
  readonly beforeAction?: (
    box: Aim["box"] | null,
    version: PageVersion,
  ) => Promise<void>;
}

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function sameVersion(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.revision === b.revision &&
    a.route === b.route
  );
}

/** No action is replayed if observation after dispatch fails. */
async function observeRoute(
  page: BrowserPage,
  op: "click" | "press",
  before: PageVersion,
  remaining: (defaultMs: number, phase: StepFailurePhase) => number,
): Promise<StepOutcome> {
  let after: PageVersion;
  try {
    after = await pageVersion(page);
  } catch {
    // A document replacement can destroy the evaluation context once.
    const settled = await page
      .settle({
        state: "domcontentloaded",
        timeoutMs: remaining(4_000, "post_dispatch"),
      })
      .catch(() => ({ settled: false }));
    if (!settled.settled)
      throw new StepExecutionError(op, "action_uncertain", "post_dispatch");
    try {
      after = await pageVersion(page);
    } catch {
      throw new StepExecutionError(op, "action_uncertain", "post_dispatch");
    }
  }
  if (after.document !== before.document) {
    const settled = await page
      .settle({
        state: "domcontentloaded",
        timeoutMs: remaining(4_000, "post_dispatch"),
      })
      .catch(() => ({ settled: false }));
    if (!settled.settled)
      throw new StepExecutionError(op, "action_uncertain", "post_dispatch");
  }
  if (after.route !== before.route) {
    const observed = await quietPage(
      page,
      80,
      remaining(1_000, "post_dispatch"),
    ).catch(() => ({ quiet: false }));
    if (!observed.quiet)
      throw new StepExecutionError(op, "action_uncertain", "post_dispatch");
  }
  return after.route !== before.route ? "route_changed" : "no_route_change";
}

export async function executeStep(
  page: BrowserPage,
  command: StepCommand,
  options: StepExecutionOptions = {},
): Promise<StepExecutionResult> {
  const started = performance.now();
  const op = command.op;
  if (options.timeoutMs !== undefined && !finiteNonnegative(options.timeoutMs))
    throw new StepExecutionError(op, "invalid_input", "pre_dispatch");
  const deadline =
    options.timeoutMs === undefined ? Infinity : started + options.timeoutMs;
  const remaining = (defaultMs: number, phase: StepFailurePhase) => {
    const budget = Math.min(defaultMs, deadline - performance.now());
    if (budget <= 0) throw new StepExecutionError(op, "timeout", phase);
    return Math.max(1, budget);
  };
  let phase: StepFailurePhase = "pre_dispatch";
  let outcome: StepOutcome = "acted";
  let displayUrl: string | undefined;
  const active = async <T>(operation: Promise<T>): Promise<T> => {
    const signal = options.signal;
    if (!signal) return operation;
    if (signal.aborted) throw new StepExecutionError(op, "canceled", phase);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () =>
        finish(new StepExecutionError(op, "canceled", phase));
      const finish = (error?: unknown, value?: T) => {
        signal.removeEventListener("abort", onAbort);
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  };
  try {
    switch (command.op) {
      case "click": {
        const target = command.target.driverTarget();
        const before = await active(pageVersion(page));
        if (!sameVersion(before, target.version))
          throw new StepExecutionError(op, "stale", phase);
        const aimed = await active(clickTarget(page, target.ref));
        if (!aimed.actionable)
          throw new StepExecutionError(
            op,
            aimed.reason === "not_actionable" ? "not_actionable" : "stale",
            phase,
          );
        if (
          aimed.aim.document !== before.document ||
          aimed.aim.route !== before.route ||
          aimed.aim.revision !== before.revision
        )
          throw new StepExecutionError(op, "stale", phase);
        const timeoutMs = remaining(8_000, phase);
        if (options.beforeAction) {
          await active(
            options.beforeAction(aimed.aim.box ?? null, target.version),
          ).catch((error: unknown) => {
            if (options.signal?.aborted) throw error;
          });
        }
        if (options.signal?.aborted)
          throw new StepExecutionError(op, "canceled", phase);
        phase = "post_dispatch";
        const result = await active(page.clickRef(aimed.aim, { timeoutMs }));
        if (!result.actionable)
          throw new StepExecutionError(
            op,
            result.reason === "action_started"
              ? "action_uncertain"
              : result.reason === "not_actionable"
                ? "not_actionable"
                : "stale",
            result.reason === "action_started"
              ? "post_dispatch"
              : "pre_dispatch",
            result.reason === "action_started"
              ? safeCallLog(
                  new Error(`Call log:\n${(result.callLog ?? []).join("\n")}`),
                )
              : [],
          );
        outcome = await active(observeRoute(page, "click", before, remaining));
        break;
      }
      case "type": {
        const target = command.target.driverTarget();
        const timeoutMs = remaining(8_000, phase);
        if (options.beforeAction) {
          const before = await active(pageVersion(page));
          if (!sameVersion(before, target.version))
            throw new StepExecutionError(op, "stale", phase);
          const aimed = await active(clickTarget(page, target.ref)).catch(
            (error: unknown) => {
              if (options.signal?.aborted) throw error;
              return null;
            },
          );
          const box =
            aimed?.actionable &&
            aimed.aim.document === before.document &&
            aimed.aim.route === before.route &&
            aimed.aim.revision === before.revision
              ? (aimed.aim.box ?? null)
              : null;
          await active(options.beforeAction(box, target.version)).catch(
            (error: unknown) => {
              if (options.signal?.aborted) throw error;
            },
          );
          if (options.signal?.aborted)
            throw new StepExecutionError(op, "canceled", phase);
        }
        phase = "post_dispatch";
        const result = await active(
          page.fillRef(target, command.value.reveal(), { timeoutMs }),
        );
        if (!result.acted)
          throw new StepExecutionError(
            op,
            result.reason === "action_started"
              ? "action_uncertain"
              : result.reason === "not_actionable"
                ? "not_actionable"
                : "stale",
            result.reason === "action_started"
              ? "post_dispatch"
              : "pre_dispatch",
            safeCallLog(
              new Error(`Call log:\n${(result.callLog ?? []).join("\n")}`),
            ),
          );
        break;
      }
      case "press": {
        if (!command.key.trim())
          throw new StepExecutionError(op, "invalid_input", phase);
        const before = await active(pageVersion(page));
        const timeoutMs = remaining(8_000, phase);
        phase = "post_dispatch";
        await active(page.press(command.key, { timeoutMs }));
        outcome = await active(observeRoute(page, "press", before, remaining));
        break;
      }
      case "goto": {
        displayUrl = command.url.toString();
        const timeoutMs = remaining(30_000, phase);
        phase = "post_dispatch";
        await active(
          page.goto(command.url.reveal(), {
            timeoutMs,
            safeDiagnostics: true,
          }),
        );
        break;
      }
      case "scroll": {
        if (!finiteNonnegative(Math.abs(command.deltaY)))
          throw new StepExecutionError(op, "invalid_input", phase);
        const timeoutMs = remaining(8_000, phase);
        phase = "post_dispatch";
        await active(page.scroll(command.deltaY, { timeoutMs }));
        break;
      }
      case "wait": {
        if (
          !finiteNonnegative(command.durationMs) ||
          command.durationMs > 2_147_483_647
        )
          throw new StepExecutionError(op, "invalid_input", phase);
        if (command.durationMs > deadline - performance.now())
          throw new StepExecutionError(op, "timeout", phase);
        await active(
          new Promise<void>((resolve) =>
            setTimeout(resolve, command.durationMs),
          ),
        );
        break;
      }
    }
    return {
      op,
      outcome,
      elapsedMs: performance.now() - started,
      ...(displayUrl === undefined ? {} : { displayUrl }),
    };
  } catch (error) {
    if (error instanceof StepExecutionError) throw error;
    throw new StepExecutionError(
      op,
      "operation_failed",
      phase,
      safeCallLog(error),
    );
  }
}
