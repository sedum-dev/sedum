import {
  readPageVersion,
  revealValues,
  waitForPageChange,
  type ExecutionOutcome,
  type SentenceAssertionContext,
} from "./flow-assertion-support.js";
import { resultCall, withValues } from "./flow-runner-support.js";
import { redactOpaqueText } from "./flow-values.js";
import { resolveTarget, type LocatorResult } from "./locator.js";
import { controlState, quietPage } from "./page-bridge.js";
import type { ResultCall } from "./run-result.js";
import type { ElementClaim } from "./step-operands.js";

type ControlState = Awaited<ReturnType<typeof controlState>>;
type Comparison = { holds: boolean; message: string; stale: boolean };
type Inspection = {
  outcome?: ExecutionOutcome;
  message: string;
  stale: boolean;
};

function locateOptions(
  context: SentenceAssertionContext,
  operation: "click" | "fill",
  target: string,
) {
  const sentence =
    operation === "fill" ? `type into ${target}` : `click ${target}`;
  const projectText = (text: string) =>
    redactOpaqueText(text, context.opaqueEntries);
  const signal = context.dependencies.signal;
  return signal
    ? { operation, sentence, projectText, signal }
    : { operation, sentence, projectText };
}

function needsClickFallback(element: ElementClaim, found: LocatorResult) {
  if (element.operation !== "fill") return false;
  if (found.kind === "resolved") return false;
  return found.reason === "none" || found.reason === "no_candidates";
}

function combineFallback(fill: LocatorResult, click: LocatorResult) {
  const calls = [...fill.calls, ...click.calls];
  if (click.kind !== "resolved") return { ...fill, calls };
  const tag = click.target.driverTarget().tag;
  if (!["input", "textarea"].includes(tag)) return { ...fill, calls };
  return { ...click, calls };
}

function controlLocator(
  context: SentenceAssertionContext,
  element: ElementClaim,
  target: string,
) {
  const locateAs = (operation: "click" | "fill") =>
    resolveTarget(
      context.page,
      context.dependencies.provider,
      locateOptions(context, operation, target),
    );
  return async () => {
    const found = await locateAs(element.operation);
    if (!needsClickFallback(element, found)) return found;
    return combineFallback(found, await locateAs("click"));
  };
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
const comparison = (holds: boolean, message: string): Comparison => ({
  holds,
  message,
  stale: false,
});

function compareReadableValue(state: ControlState, expected: string) {
  if (state.status !== "ok" || state.value === null) return false;
  return normalize(state.value) === expected;
}

function compareControl(
  element: ElementClaim,
  state: ControlState,
  wanted: string,
) {
  if (state.status !== "ok") {
    return {
      holds: false,
      message: "The page changed while the control was read.",
      stale: true,
    };
  }
  return compareStableControl(element, state, wanted);
}

function compareStableControl(
  element: ElementClaim,
  state: Extract<ControlState, { status: "ok" }>,
  wanted: string,
) {
  const expected = element.expect;
  if (expected.kind === "disabled") {
    return comparison(
      state.disabled === expected.disabled,
      `The control is ${state.disabled ? "disabled" : "enabled"}.`,
    );
  }
  if (expected.kind === "checked") {
    const message =
      state.checked === null
        ? "The control cannot be checked."
        : `The control is ${state.checked ? "checked" : "unchecked"}.`;
    return comparison(state.checked === expected.checked, message);
  }
  if (expected.kind === "focused") {
    return comparison(
      state.focused === expected.focused,
      `The control is ${state.focused ? "" : "not "}focused.`,
    );
  }
  const message =
    state.value === null
      ? "The control holds no readable value."
      : "The field holds a different value.";
  if (expected.kind === "empty") {
    const holds =
      state.value !== null &&
      (normalize(state.value) === "") === expected.empty;
    return comparison(holds, message);
  }
  return comparison(compareReadableValue(state, wanted), message);
}

function missingControl(result: LocatorResult) {
  if (result.kind === "resolved") return false;
  return result.reason === "none" || result.reason === "no_candidates";
}

async function inspectControl(
  context: SentenceAssertionContext,
  element: ElementClaim,
  result: LocatorResult,
  earlier: readonly ResultCall[],
): Promise<Inspection> {
  if (result.kind !== "resolved")
    return inspectMissing(context, element, result, earlier);
  if (element.expect.kind === "present") {
    if (element.expect.present) {
      const outcome = await recordSuccess(context, result, earlier);
      return { outcome, message: "", stale: false };
    }
    return { message: "The control is on the page.", stale: false };
  }
  const wanted =
    element.expect.kind === "value"
      ? normalize(revealValues(element.expect.value, context.data))
      : "";
  const state = await controlState(context.page, result.target.driverTarget());
  const checked = compareControl(element, state, wanted);
  if (checked.holds) {
    const outcome = await recordSuccess(context, result, earlier);
    return { outcome, message: "", stale: false };
  }
  return checked;
}

async function inspectMissing(
  context: SentenceAssertionContext,
  element: ElementClaim,
  result: LocatorResult,
  earlier: readonly ResultCall[],
): Promise<Inspection> {
  const absent = missingControl(result);
  const expectedAbsent =
    element.expect.kind === "present" && !element.expect.present;
  if (absent && expectedAbsent) {
    const outcome = await recordSuccess(context, result, earlier);
    return { outcome, message: "", stale: false };
  }
  const message = absent
    ? "No such control is on the page."
    : `The control could not be found (${result.kind === "unresolved" ? result.reason : "unknown"}).`;
  return { message, stale: false };
}

function recordSuccess(
  context: SentenceAssertionContext,
  result: LocatorResult,
  earlier: readonly ResultCall[],
) {
  return context.record("continue", { locator: result, failedCalls: earlier });
}

async function settleStale(context: SentenceAssertionContext) {
  await quietPage(context.page, 80, 2_000).catch(() => undefined);
}

function shouldRetryStale(inspection: Inspection, staleRetried: boolean) {
  if (staleRetried) return false;
  return inspection.stale;
}

function appendPreviousCalls(earlier: ResultCall[], last?: LocatorResult) {
  if (!last) return;
  earlier.push(...last.calls.map((call) => resultCall(call, "locator")));
}

function controlFailureFacts(
  last: LocatorResult | undefined,
  earlier: readonly ResultCall[],
  message: string,
) {
  const facts = {
    failedCalls: earlier,
    error: { code: "element_state", message },
  };
  if (!last) return facts;
  return { ...facts, locator: last };
}

export async function executeControlAssertion(
  context: SentenceAssertionContext,
  element: ElementClaim,
  limitMs: number,
) {
  const deadline = performance.now() + limitMs;
  const earlier: ResultCall[] = [];
  const locate = controlLocator(
    context,
    element,
    withValues(element.target, context.data),
  );
  let last: LocatorResult | undefined;
  let message = "The control is not in the expected state.";
  let staleRetried = false;
  for (;;) {
    if (context.dependencies.signal?.aborted) break;
    const before = await readPageVersion(context.page);
    appendPreviousCalls(earlier, last);
    last = await context.reobserve(await locate(), locate);
    const inspected = await inspectControl(context, element, last, earlier);
    if (inspected.outcome) return inspected.outcome;
    message = inspected.message;
    if (shouldRetryStale(inspected, staleRetried)) {
      staleRetried = true;
      await settleStale(context);
      continue;
    }
    if (!(await waitForPageChange(context, before, deadline, false))) break;
    await quietPage(context.page, 80, 2_000).catch(() => undefined);
  }
  return context.record("failed", controlFailureFacts(last, earlier, message));
}
