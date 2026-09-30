import type { BrowserPage } from "./browser-driver.js";
import {
  verify,
  AssertionEngineError,
  type VerifyPolicy,
} from "./assertion-engine.js";
import { collectCandidates, pageDigest, pageVersion } from "./page-bridge.js";
import type { Candidate, PageVersion } from "./page-protocol.js";
import { redactOpaqueText, type ResolvedDataEntry } from "./flow-values.js";
import {
  ProviderError,
  unknownCostCall,
  type Judge,
  type ProviderCall,
  type ProviderCallOptions,
} from "./provider.js";
import {
  executeStep,
  ResolvedStepTarget,
  StepExecutionError,
  type StepCommand,
} from "./step-executor.js";

/** Goal planning state; authored-step execution uses its separate runner. */
export interface GoalState {
  readonly goal: string;
  readonly page: string;
  readonly recentActions: readonly string[];
  readonly targets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Optional host-authored experiment context; never include secret values. */
  readonly declaredDataKeys?: readonly string[];
  readonly completionCriteria?: readonly string[];
  readonly operationInstructions?: string;
}
export interface GoalChoice {
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
}
export interface GoalDecision {
  readonly operation: GoalChoice;
  readonly target?: GoalChoice;
  readonly call: ProviderCall;
}
export interface GoalPlanner {
  /** Exactly one HTTP attempt; operation and speculative target heads share it. */
  chooseGoal(
    state: GoalState,
    options?: ProviderCallOptions,
  ): Promise<GoalDecision>;
}
export interface GoalOptions {
  readonly goal: string;
  readonly verify: readonly string[];
  readonly verifyPolicy?: VerifyPolicy;
  readonly data?: Readonly<Record<string, ResolvedDataEntry>>;
  /** Host-authored allowlist for narrowly scoped read-only experiments, not a security sandbox. */
  readonly allowedClickNames?: readonly string[];
  readonly maxRequests?: number;
  readonly maxActions?: number;
  readonly timeoutMs?: number;
  /** Experimental operation-only margin; target margin and confidence floors stay fixed. */
  readonly operationMinMargin?: number;
  readonly signal?: AbortSignal;
  /** Awaited after each dispatched action; contains no typed values. */
  readonly onAction?: (action: GoalAction) => Promise<void>;
}
export interface GoalAction {
  readonly operation: "click" | "type";
  readonly sentence: string;
  readonly targetName: string;
  readonly targetRole: string;
  readonly confidence: number | null;
  readonly probability: number;
  /** Internal provenance for privacy checks, not for serialization. */
  readonly beforeVersion: PageVersion;
  readonly status: "passed" | "failed";
  readonly reason: string | null;
  readonly elapsedMs: number;
  readonly calls: readonly ProviderCall[];
}
export interface GoalResult {
  readonly status: "passed" | "failed";
  readonly reason: string;
  readonly requests: number;
  readonly actions: number;
  readonly elapsedMs: number;
  readonly calls: readonly ProviderCall[];
  readonly history: readonly string[];
  /**
   * For an abstention: which choice was uncertain, where, and its top
   * probabilities, e.g. "operation on …/inventory.html: BLOCKED 0.48,
   * CLICK 0.46". Contains no typed values.
   */
  readonly detail?: string;
  readonly verification: readonly {
    claim: string;
    verdict: string;
    holds: number;
    contradicted: number;
    flags: readonly string[];
  }[];
}

export function goalOperations(state: GoalState): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.keys(state.targets).map((op) => [
        op,
        op === "TYPE"
          ? "Fill one field with a supplied data binding"
          : "Click one observed element",
      ]),
    ),
    DONE: "All goal requirements are visibly satisfied; request independent verification",
    BLOCKED:
      "No offered element or field can move the goal forward from this page; abstain",
  };
}

/** Same confidence and comparable-margin floor as Sedum's strict locator. */
export function goalChoiceAccepted(
  answer: GoalChoice,
  ids: readonly string[],
  minMargin = 0.1,
): boolean {
  const keys = Object.keys(answer.probabilities);
  const values = Object.values(answer.probabilities);
  if (
    !ids.includes(answer.choice) ||
    keys.length !== ids.length ||
    keys.some((k) => !ids.includes(k)) ||
    values.some((p) => !Number.isFinite(p) || p < 0 || p > 1) ||
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) >= 0.02 ||
    (answer.confidence !== null &&
      (!Number.isFinite(answer.confidence) ||
        answer.confidence < 0.3 ||
        answer.confidence > 1))
  )
    return false;
  const selected = answer.probabilities[answer.choice]!;
  const other = Math.max(
    0,
    ...keys
      .filter((k) => k !== answer.choice)
      .map((k) => answer.probabilities[k]!),
  );
  return selected - other >= minMargin;
}

function same(a: PageVersion, b: PageVersion): boolean {
  return (
    a.document === b.document &&
    a.revision === b.revision &&
    a.route === b.route
  );
}

/** No generated text, selectors, JavaScript, arbitrary keys, or navigation URLs. */
export async function runGoal(
  page: BrowserPage,
  planner: GoalPlanner,
  judge: Judge,
  options: GoalOptions,
): Promise<GoalResult> {
  const started = performance.now();
  const maxRequests = options.maxRequests ?? 24;
  const maxActions = options.maxActions ?? 18;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const operationMinMargin = options.operationMinMargin ?? 0.1;
  if (
    !Number.isFinite(operationMinMargin) ||
    operationMinMargin < 0 ||
    operationMinMargin > 1
  )
    throw new RangeError("Invalid goal operation margin");
  for (const [value, cap] of [
    [maxRequests, 64],
    [maxActions, 48],
    [timeoutMs, 300_000],
  ])
    if (!Number.isSafeInteger(value) || value! < 1 || value! > cap!)
      throw new RangeError("Invalid goal budget");
  if (
    !options.goal.trim() ||
    !options.verify.length ||
    options.verify.some((s) => !s.trim())
  )
    throw new TypeError(
      "Goal and independent verification claims are required",
    );
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const signal = controller.signal;
  const active = async <T>(promise: Promise<T>): Promise<T> => {
    if (signal.aborted) throw new Error("deadline");
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("deadline"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const entries = Object.values(options.data ?? {});
  // Also redact sensitive values constructed by API callers without opaqueValues.
  const taints = entries.map((entry) =>
    entry.sensitive
      ? { ...entry, opaqueValues: [...(entry.opaqueValues ?? []), entry.value] }
      : entry,
  );
  const project = (text: string) => redactOpaqueText(text, taints);
  const calls: ProviderCall[] = [];
  const history: string[] = [];
  const verification: {
    claim: string;
    verdict: string;
    holds: number;
    contradicted: number;
    flags: readonly string[];
  }[] = [];
  let requests = 0;
  let actions = 0;
  let pendingCall = false;
  let reportedCalls = 0;
  const result = (reason: string, detail?: string): GoalResult => ({
    status: reason === "verified" ? "passed" : "failed",
    reason,
    requests,
    actions,
    elapsedMs: Math.round(performance.now() - started),
    calls,
    history,
    ...(detail ? { detail } : {}),
    verification,
  });
  /** The top of an uncertain choice, so a failed goal says what was close. */
  const uncertain = (
    what: string,
    answer: GoalChoice | undefined,
    route: string,
    label: (choice: string) => string = (choice) => choice,
  ) => {
    let where = route;
    try {
      where = new URL(route).pathname || route;
    } catch {
      // Keep the raw route.
    }
    const top = answer
      ? Object.entries(answer.probabilities)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([choice, p]) => `${label(choice)} ${p.toFixed(2)}`)
          .join(", ")
      : "no answer";
    return project(`${what} on ${where}: ${top}`);
  };
  const seen = new Map<string, number>();
  try {
    while (!signal.aborted) {
      if (requests >= maxRequests) return result("request_limit");
      const digest = await active(pageDigest(page));
      if (!digest.complete || digest.error)
        return result("incomplete_observation");
      const clicks = await active(collectCandidates(page, "click"));
      const fills = await active(collectCandidates(page, "fill"));
      if (
        !clicks.complete ||
        !fills.complete ||
        clicks.next !== null ||
        fills.next !== null
      )
        return result("candidate_limit");
      if (
        !same(digest.version, clicks.version) ||
        !same(digest.version, fills.version)
      )
        continue;
      const targets: Record<string, Record<string, string>> = {};
      const commands = new Map<string, StepCommand>();
      const bindingKeys = new Map<string, string>();
      // Read only binding matches and occupancy, never send field values to the model.
      const fieldState = await active(
        page.evaluate<{ populated: boolean; bindings: string[] }[]>(
          `(({ refs, bindings }) => refs.map(ref => {
          const element = [...document.querySelectorAll('[data-sedum-ref]')].find(e => e.getAttribute('data-sedum-ref') === ref);
          const value = element && ('value' in element ? element.value : element.textContent);
          return { populated: !!value, bindings: bindings.filter(([,text]) => value === text).map(([key]) => key) };
        }))(${JSON.stringify({
          refs: fills.candidates.map((c) => c.ref),
          bindings: Object.entries(options.data ?? {}).map(([key, entry]) => [
            key,
            entry.value.reveal(),
          ]),
        })})`,
        ),
      );
      const describe = (c: Candidate) =>
        JSON.stringify({
          name: project(c.name),
          role: c.role,
          peers: c.peers.map(project),
          location: c.location === undefined ? undefined : project(c.location),
        });
      const target = (c: Candidate) =>
        new ResolvedStepTarget({
          ref: c.ref,
          tag: c.tag,
          name: c.name,
          version: digest.version,
        });
      for (const c of clicks.candidates.filter(
        (c) =>
          !c.disabled &&
          (options.allowedClickNames === undefined ||
            options.allowedClickNames.includes(c.name)),
      )) {
        const id = `c${commands.size}`;
        (targets.CLICK ??= {})[id] = describe(c);
        commands.set(id, { op: "click", target: target(c) });
      }
      for (const [index, c] of fills.candidates.entries()) {
        if (c.disabled || !c.editable) continue;
        const current = fieldState[index]!;
        for (const [key, entry] of Object.entries(options.data ?? {})) {
          if (current.bindings.includes(key)) continue;
          const id = `t${commands.size}`;
          (targets.TYPE ??= {})[id] =
            `${describe(c)} current=${current.populated ? `populated (${current.bindings.join(",")})` : "empty"} ← {{${key}}}${entry.sensitive ? " (secret)" : ` = ${project(entry.value.reveal())}`}`;
          commands.set(id, {
            op: "type",
            target: target(c),
            value: entry.value,
          });
          bindingKeys.set(id, key);
        }
      }
      if (Object.values(targets).some((t) => Object.keys(t).length > 254))
        return result("candidate_limit");
      if (!same(digest.version, await active(pageVersion(page)))) continue;
      // Raw values stay local; detect cycles as well as consecutive unchanged pages.
      const fingerprint = JSON.stringify([
        digest.version.route,
        digest.text,
        fieldState,
      ]);
      const visits = (seen.get(fingerprint) ?? 0) + 1;
      seen.set(fingerprint, visits);
      if (visits > 3) return result("no_progress");
      const state: GoalState = {
        goal: project(options.goal),
        page: project(digest.text),
        recentActions: history.slice(-10),
        targets,
      };
      if (Buffer.byteLength(JSON.stringify(state)) > 60 * 1024)
        return result("request_too_large");
      requests++;
      pendingCall = true;
      const decision = await active(
        planner.chooseGoal(state, { signal, maxAttempts: 1 }),
      );
      calls.push(decision.call);
      pendingCall = false;
      if (
        !goalChoiceAccepted(
          decision.operation,
          Object.keys(goalOperations(state)),
          operationMinMargin,
        )
      )
        return result(
          "operation_abstention",
          uncertain("operation", decision.operation, digest.version.route),
        );
      if (!same(digest.version, await active(pageVersion(page)))) continue;
      const op = decision.operation.choice;
      if (op === "BLOCKED") return result("blocked");
      if (op === "DONE") {
        for (const claim of options.verify) {
          if (requests >= maxRequests) return result("request_limit");
          requests++;
          const singleAttemptJudge: Judge = {
            holds: (text, snapshot, callOptions) => {
              pendingCall = true;
              return judge.holds(text, snapshot, {
                ...callOptions,
                maxAttempts: 1,
              });
            },
          };
          const checked = await active(
            verify(page, singleAttemptJudge, project(claim), {
              ...options.verifyPolicy,
              signal,
              projectText: project,
            }),
          );
          calls.push(checked.call);
          pendingCall = false;
          verification.push({
            claim: project(claim),
            verdict: checked.verdict,
            holds: checked.holds,
            contradicted: checked.contradicted,
            flags: checked.flags,
          });
          if (checked.verdict !== "passed" || checked.flags.length)
            return result("verification_failed");
        }
        return result("verified");
      }
      const head = decision.target;
      if (
        !head ||
        !goalChoiceAccepted(head, Object.keys(state.targets[op] ?? {}))
      )
        return result(
          "target_abstention",
          uncertain(`${op} target`, head, digest.version.route, (id) => {
            const name = (() => {
              try {
                return (
                  JSON.parse(state.targets[op]?.[id] ?? "{}") as {
                    name?: string;
                  }
                ).name;
              } catch {
                return undefined;
              }
            })();
            return name ? `"${name}"` : id;
          }),
        );
      const command = commands.get(head.choice);
      if (!command) return result("invalid_target");
      if (actions >= maxActions) return result("action_limit");
      // Sedum owns ONE operation-specific snapshot. Recollect the chosen operation
      // and require its entire surface and exact version to match before remapping refs.
      if (command.op !== "click" && command.op !== "type")
        return result("invalid_target");
      const source = command.op === "click" ? clicks : fills;
      const fresh = await active(
        collectCandidates(page, command.op === "click" ? "click" : "fill"),
      );
      const surface = (candidates: readonly Candidate[]) =>
        JSON.stringify(candidates.map((c) => ({ ...c, ref: undefined })));
      if (
        !fresh.complete ||
        fresh.next !== null ||
        !same(source.version, fresh.version) ||
        surface(source.candidates) !== surface(fresh.candidates)
      )
        return result("stale_observation");
      const index = source.candidates.findIndex(
        (c) => c.ref === command.target.driverTarget().ref,
      );
      const chosen = fresh.candidates[index];
      if (!chosen) return result("invalid_target");
      const refreshed = { ...command, target: target(chosen) };
      if (signal.aborted) return result("timeout");
      // Consume and record BEFORE dispatch. Any executor failure terminates; never replay.
      actions++;
      history.push(project(`${op} ${targets[op]![head.choice]}`));
      const actionStarted = performance.now();
      const binding = bindingKeys.get(head.choice);
      const sentence = project(
        command.op === "type"
          ? `Type {{${binding}}} into ${chosen.name}`
          : `Click ${chosen.name}${chosen.peers[0] ? ` (${chosen.peers[0]})` : ""}`,
      );
      let failure: unknown;
      let failed = false;
      try {
        await active(
          executeStep(page, refreshed, {
            signal,
            timeoutMs: Math.min(
              8_000,
              timeoutMs - (performance.now() - started),
            ),
          }),
        );
      } catch (error) {
        failed = true;
        failure = error;
      }
      // A target that went stale before dispatch provably received no input,
      // so no action happened: take it back and observe the page again.
      // Each retry still costs a planner request, which bounds the loop.
      if (
        failed &&
        failure instanceof StepExecutionError &&
        failure.code === "stale" &&
        failure.phase === "pre_dispatch" &&
        !signal.aborted
      ) {
        actions--;
        history.pop();
        continue;
      }
      await options.onAction?.({
        operation: command.op,
        sentence,
        targetName: project(chosen.name),
        targetRole: chosen.role,
        confidence: head.confidence,
        probability: head.probabilities[head.choice]!,
        beforeVersion: fresh.version,
        status: failed ? "failed" : "passed",
        reason: !failed
          ? null
          : signal.aborted
            ? "timeout"
            : failure instanceof StepExecutionError
              ? `${failure.code}:${failure.phase}`
              : "action_failed",
        elapsedMs: performance.now() - actionStarted,
        calls: calls.slice(reportedCalls),
      });
      reportedCalls = calls.length;
      if (failed) throw failure;
    }
    return result("timeout");
  } catch (error) {
    if (pendingCall) calls.push(unknownCostCall(error));
    return result(
      signal.aborted
        ? "timeout"
        : error instanceof StepExecutionError
          ? `${error.code}:${error.phase}`
          : error instanceof ProviderError ||
              error instanceof AssertionEngineError
            ? error.code
            : "observation_or_provider_error",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
