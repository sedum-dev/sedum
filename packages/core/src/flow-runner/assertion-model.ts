import {
  AssertionEngineError,
  measure,
  verify,
  type MeasureResult,
  type VerifyResult,
} from "../assertion-engine.js";
import {
  assertionFailure,
  readPageVersion,
  waitForPageChange,
  type ExecutionOutcome,
  type SentenceAssertionContext,
} from "./assertion-support.js";
import { claim, resultCall, withValues } from "./support.js";
import { redactOpaqueText } from "../flow-values.js";
import { quietPage, visibleText } from "../page-bridge.js";
import { isRunWideProviderError } from "../provider.js";
import type { ResultCall } from "../run-result.js";
import { countText, literalShown } from "../step-operands.js";

type Judgment = VerifyResult | MeasureResult;
type Judge = (signal?: AbortSignal, timeout?: number) => Promise<Judgment>;
type AttemptResult =
  | { readonly kind: "passed"; readonly outcome: ExecutionOutcome }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "retry" };

function createJudge(context: SentenceAssertionContext): Judge {
  return (signal = context.dependencies.signal, observationTimeoutMs) => {
    const options = {
      projectText: (text: string) =>
        redactOpaqueText(text, context.opaqueEntries),
      ...(signal ? { signal } : {}),
      ...(observationTimeoutMs === undefined ? {} : { observationTimeoutMs }),
    };
    const assertion = claim(context.step, context.data);
    if (context.step.op === "measure") {
      return measure(
        context.page,
        context.dependencies.provider,
        assertion,
        options,
      );
    }
    return verify(context.page, context.dependencies.provider, assertion, {
      ...options,
      ...(context.dependencies.verifyPolicy ?? {}),
    });
  };
}

function passed(result: Judgment) {
  if (result.kind !== "verify") return true;
  return result.verdict !== "failed";
}

function deadlineSignal(context: SentenceAssertionContext, deadline: number) {
  const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
  const timeout = AbortSignal.timeout(remaining);
  const signal = context.dependencies.signal
    ? AbortSignal.any([context.dependencies.signal, timeout])
    : timeout;
  return { remaining, signal };
}

function retryable(error: unknown, hasLiteral: boolean) {
  if (!(error instanceof AssertionEngineError)) return false;
  const codes = ["stale_observation", "observation_timeout", "browser_failure"];
  if (hasLiteral) codes.push("oversize_digest", "resource_ceiling");
  return codes.includes(error.code);
}

function appendJudgment(calls: ResultCall[], result?: Judgment) {
  if (result) calls.push(resultCall(result.call, "judge", result.elapsedMs));
}

function appendFailure(calls: ResultCall[], error: unknown) {
  if (error instanceof AssertionEngineError && error.failedCall) {
    calls.push(resultCall(error.failedCall, "judge"));
  }
}

async function literalIsShown(
  context: SentenceAssertionContext,
  literal: string,
) {
  await quietPage(context.page, 80, 2_000).catch(() => undefined);
  const text = await visibleText(context.page).catch(() => null);
  if (text === null) return false;
  return countText(text, literal, true) > 0;
}

async function finishPoll(
  context: SentenceAssertionContext,
  last: Judgment | undefined,
  lastError: unknown,
  earlier: readonly ResultCall[],
) {
  if (!last) return assertionFailure(context, lastError, earlier);
  return context.record(passed(last) ? "continue" : "failed", {
    verify: last,
    failedCalls: earlier,
  });
}

interface PollState {
  last?: Judgment;
  lastError?: unknown;
  readonly earlier: ResultCall[];
}

interface PollAttempt {
  readonly context: SentenceAssertionContext;
  readonly judge: Judge;
  readonly state: PollState;
  readonly deadline: number;
  readonly bounded: boolean;
}

async function judgePollAttempt(attempt: PollAttempt): Promise<AttemptResult> {
  const { context, judge, state, deadline, bounded } = attempt;
  try {
    const timing = bounded ? deadlineSignal(context, deadline) : undefined;
    const result = timing
      ? await judge(timing.signal, timing.remaining)
      : await judge();
    if (passed(result)) {
      appendJudgment(state.earlier, state.last);
      const outcome = await context.record("continue", {
        verify: result,
        failedCalls: state.earlier,
      });
      return { kind: "passed", outcome };
    }
    appendJudgment(state.earlier, state.last);
    state.last = result;
    state.lastError = undefined;
    return { kind: "retry" };
  } catch (error) {
    if (isRunWideProviderError(error)) {
      appendJudgment(state.earlier, state.last);
      throw await context.runWide(error, { failedCalls: state.earlier });
    }
    appendFailure(state.earlier, error);
    state.lastError = error;
    return { kind: "failed", error };
  }
}

function deadlineError(
  context: SentenceAssertionContext,
  deadline: number,
  bounded: boolean,
) {
  if (!bounded || performance.now() < deadline) return undefined;
  if (context.dependencies.signal?.aborted) return undefined;
  return new AssertionEngineError("observation_timeout");
}

function pollDeadline(deadline: number, unchangedMs: number | null) {
  if (unchangedMs === null) return deadline;
  return Math.min(deadline, performance.now() + unchangedMs);
}

function shouldStopPolling(attempt: AttemptResult, literal: string | null) {
  if (attempt.kind !== "failed") return false;
  return !retryable(attempt.error, literal !== null);
}

async function awaitNextPoll(
  context: SentenceAssertionContext,
  before: Awaited<ReturnType<typeof readPageVersion>>,
  deadline: number,
  unchangedMs: number | null,
) {
  const changed = await waitForPageChange(
    context,
    before,
    pollDeadline(deadline, unchangedMs),
  );
  if (context.dependencies.signal?.aborted) return "retry";
  if (!changed && unchangedMs === null) return "stop";
  if (performance.now() >= deadline) return "stop";
  await quietPage(context.page, 80, 2_000).catch(() => undefined);
  return "retry";
}

async function literalPassed(
  context: SentenceAssertionContext,
  literal: string | null,
) {
  if (!literal) return false;
  return literalIsShown(context, literal);
}

function canceled(context: SentenceAssertionContext) {
  return context.dependencies.signal?.aborted === true;
}

async function pollAssertion(
  context: SentenceAssertionContext,
  limitMs: number,
  unchangedMs: number | null,
  literal: string | null,
): Promise<ExecutionOutcome> {
  const judge = createJudge(context);
  const bounded = limitMs > 0;
  const deadline = performance.now() + limitMs;
  const state: PollState = { earlier: [] };
  for (;;) {
    if (canceled(context)) {
      appendJudgment(state.earlier, state.last);
      return assertionFailure(
        context,
        new AssertionEngineError("canceled"),
        state.earlier,
      );
    }
    const before = await readPageVersion(context.page);
    if (await literalPassed(context, literal)) {
      return context.record("continue", { failedCalls: state.earlier });
    }
    const attempt = await judgePollAttempt({
      context,
      judge,
      state,
      deadline,
      bounded,
    });
    if (attempt.kind === "passed") return attempt.outcome;
    const timedOut = deadlineError(context, deadline, bounded);
    if (timedOut) {
      state.lastError = timedOut;
      break;
    }
    if (shouldStopPolling(attempt, literal)) break;
    if (
      (await awaitNextPoll(context, before, deadline, unchangedMs)) === "stop"
    )
      break;
  }
  return finishPoll(context, state.last, state.lastError, state.earlier);
}

async function retryJudgment(
  context: SentenceAssertionContext,
  judge: Judge,
  calls: ResultCall[],
) {
  try {
    const result = await judge();
    return context.record(passed(result) ? "continue" : "failed", {
      verify: result,
      failedCalls: calls,
    });
  } catch (error) {
    if (isRunWideProviderError(error))
      throw await context.runWide(error, { failedCalls: calls });
    appendFailure(calls, error);
    return assertionFailure(context, error, calls);
  }
}

async function judgeOnce(context: SentenceAssertionContext) {
  const judge = createJudge(context);
  try {
    const result = await judge();
    return context.record(passed(result) ? "continue" : "failed", {
      verify: result,
    });
  } catch (error) {
    return handleInitialFailure(context, judge, error);
  }
}

async function handleInitialFailure(
  context: SentenceAssertionContext,
  judge: Judge,
  error: unknown,
) {
  if (isRunWideProviderError(error)) throw await context.runWide(error);
  const calls: ResultCall[] = [];
  appendFailure(calls, error);
  const stale =
    error instanceof AssertionEngineError && error.code === "stale_observation";
  if (!stale) return assertionFailure(context, error, calls);
  const settled = await quietPage(context.page, 80, 4_000).catch(() => ({
    quiet: false,
  }));
  if (!settled.quiet) return assertionFailure(context, error, calls);
  return retryJudgment(context, judge, calls);
}

function needsGracePoll(
  context: SentenceAssertionContext,
  graceMs: number,
  literal: string | null,
) {
  if (context.step.op !== "verify") return false;
  if (graceMs > 0) return true;
  return literal !== null;
}

export function executeModelAssertion(
  context: SentenceAssertionContext,
  assertionText: string,
  until: number | null,
  graceMs: number,
) {
  const shown =
    context.step.op === "verify" ? literalShown(assertionText) : null;
  const literal = shown ? withValues(shown, context.data) : null;
  if (until !== null) return pollAssertion(context, until, 5_000, literal);
  if (needsGracePoll(context, graceMs, literal)) {
    return pollAssertion(context, graceMs, null, literal);
  }
  return judgeOnce(context);
}
