import type { BrowserPage } from "./browser-driver.js";
import { randomInt } from "node:crypto";
import { goalGenerators } from "./goal-data.js";
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
  RuntimeValue,
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
  readonly automaticData?: boolean;
  /** TypeScript goals stop at planner completion; YAML requests verification. */
  readonly completion?: "planner";
}
export interface GoalValueState {
  readonly goal: string;
  readonly page: string;
  readonly field: string;
  readonly choices: Readonly<Record<string, string>>;
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
  /** Optional for older providers; enables automatic synthetic data in goal mode. */
  chooseGoalValue?(
    state: GoalValueState,
    options?: ProviderCallOptions,
  ): Promise<{ readonly value: GoalChoice; readonly call: ProviderCall }>;
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
  /** Reproduce the POC's local Faker sequence (English locale, pinned version). */
  readonly dataSeed?: number;
  readonly signal?: AbortSignal;
  /** Redaction history, never offered as available fill bindings. */
  readonly opaqueEntries?: readonly ResolvedDataEntry[];
  /** Register generated text with the host's report redactor before any fill. */
  readonly onGeneratedValue?: (value: RuntimeValue) => void;
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
  readonly dataSeed?: number;
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
          ? state.automaticData
            ? "Fill one field using supplied, remembered, or automatically generated synthetic data"
            : "Fill one field with a supplied data binding"
          : "Click one observed element",
      ]),
    ),
    DONE:
      state.completion === "planner"
        ? "All goal requirements are visibly satisfied; finish the task"
        : "All goal requirements are visibly satisfied; request independent verification",
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

/** Only host-owned value generators; no model-authored text or executable code. */
export async function runGoal(
  page: BrowserPage,
  planner: GoalPlanner,
  judge: Judge,
  options: GoalOptions,
): Promise<GoalResult> {
  return executeGoal(page, planner, options, {
    kind: "verified",
    judge,
    claims: options.verify,
  });
}

/** @internal TypeScript authoring stops at planner completion, not verification. */
export function runGoalTask(
  page: BrowserPage,
  planner: GoalPlanner,
  options: Omit<GoalOptions, "verify" | "verifyPolicy">,
): Promise<GoalResult> {
  return executeGoal(page, planner, options, { kind: "planner" });
}

async function executeGoal(
  page: BrowserPage,
  planner: GoalPlanner,
  options: Omit<GoalOptions, "verify">,
  completion:
    | { kind: "planner" }
    | { kind: "verified"; judge: Judge; claims: readonly string[] },
): Promise<GoalResult> {
  const started = performance.now();
  const maxRequests = options.maxRequests ?? 24;
  const maxActions = options.maxActions ?? 18;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const operationMinMargin = options.operationMinMargin ?? 0.1;
  const dataSeed = options.dataSeed ?? randomInt(0x7fffffff);
  if (!Number.isSafeInteger(dataSeed))
    throw new RangeError("Invalid data seed");
  const generators = planner.chooseGoalValue
    ? goalGenerators(dataSeed)
    : undefined;
  const data: Record<string, ResolvedDataEntry> = { ...options.data };
  const generated = new Map<string, string>();
  // A selected value survives a provably pre-dispatch stale retry.
  let pendingValue:
    { observation: string; index: number; key: string } | undefined;
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
    (completion.kind === "verified" &&
      (!completion.claims.length || completion.claims.some((s) => !s.trim())))
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
  const entries = [
    ...Object.values(options.data ?? {}),
    ...(options.opaqueEntries ?? []),
  ];
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
    ...(generators ? { dataSeed } : {}),
    status:
      reason === "verified" || reason === "completed" ? "passed" : "failed",
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
        page.evaluate<
          {
            populated: boolean;
            bindings: string[];
            constraints?: Record<string, string>;
          }[]
        >(
          `(({ refs, bindings }) => refs.map(ref => {
          const element = [...document.querySelectorAll('[data-sedum-ref]')].find(e => e.getAttribute('data-sedum-ref') === ref);
          const value = element && ('value' in element ? element.value : element.textContent);
          const constraints = Object.fromEntries(['autocomplete', 'minlength', 'maxlength', 'pattern', 'min', 'max', 'step', 'required'].filter(key => element?.hasAttribute(key)).map(key => [key, element.getAttribute(key)]));
          return { populated: !!value, bindings: bindings.filter(([,text]) => value === text).map(([key]) => key), constraints };
        }))(${JSON.stringify({
          refs: fills.candidates.map((c) => c.ref),
          bindings: Object.entries(data).map(([key, entry]) => [
            key,
            entry.value.reveal(),
          ]),
        })})`,
        ),
      );
      // Ignore only ephemeral element identities. A replacement may inherit a
      // pending value only while the entire field surface, visible context and
      // occupancy remain unchanged. Changed/ambiguous context fails closed.
      const valueObservation = JSON.stringify([
        digest.version.document,
        digest.version.route,
        digest.text,
        fills.candidates.map((c) => ({
          ...c,
          ref: undefined,
          signals: { ...c.signals, nodeId: undefined },
        })),
        fieldState,
      ]);
      if (pendingValue && pendingValue.observation !== valueObservation)
        return result("stale_value_target");
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
        if (generators) {
          // Already holds known data: don't repeatedly fill or regenerate it.
          if (current.populated && current.bindings.length) continue;
          const id = `t${commands.size}`;
          (targets.TYPE ??= {})[id] =
            `${describe(c)} inputType=${c.inputType} constraints=${project(JSON.stringify(current.constraints ?? {}))} current=${current.populated ? "populated (unknown value)" : "empty"}`;
          commands.set(id, {
            op: "type",
            target: target(c),
            value: new RuntimeValue(""),
          });
          continue;
        }
        for (const [key, entry] of Object.entries(data)) {
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
        ...(completion.kind === "planner"
          ? { completion: "planner" as const }
          : {}),
        ...(generators
          ? { automaticData: true, declaredDataKeys: Object.keys(data) }
          : {}),
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
      if (pendingValue && op !== "TYPE") return result("stale_value_target");
      if (op === "BLOCKED") return result("blocked");
      if (op === "DONE") {
        if (completion.kind === "planner") return result("completed");
        for (const claim of completion.claims) {
          if (requests >= maxRequests) return result("request_limit");
          requests++;
          const singleAttemptJudge: Judge = {
            holds: (text, snapshot, callOptions) => {
              pendingCall = true;
              return completion.judge.holds(text, snapshot, {
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
      let command = commands.get(head.choice);
      if (!command) return result("invalid_target");
      if (actions >= maxActions) return result("action_limit");
      if (command.op === "type" && generators && planner.chooseGoalValue) {
        const ref = command.target.driverTarget().ref;
        const index = fills.candidates.findIndex((c) => c.ref === ref);
        const field = fills.candidates[index]!;
        if (pendingValue && pendingValue.index !== index)
          return result("stale_value_target");
        let key = pendingValue?.key;
        if (!key) {
          const choices: Record<string, string> = {
            BLOCKED:
              "Requires unavailable real credentials, OTP, specific factual text, or unsupported constraints; do not invent it",
            ...Object.fromEntries(
              Object.entries(data).map(([id, entry]) => [
                `use.${id}`,
                generated.has(id)
                  ? `REUSE ${id}: ${project(generated.get(id)!)}`
                  : `USE supplied {{${id}}}${entry.sensitive ? " (secret)" : ` = ${project(entry.value.reveal())}`}`,
              ]),
            ),
            ...generators.descriptions,
          };
          if (Object.keys(choices).length > 255)
            return result("value_candidate_limit");
          if (requests >= maxRequests) return result("request_limit");
          requests++;
          pendingCall = true;
          const selected = await active(
            planner.chooseGoalValue(
              {
                goal: project(options.goal),
                page: project(digest.text),
                field: targets.TYPE![head.choice]!,
                choices,
              },
              { signal, maxAttempts: 1 },
            ),
          );
          calls.push(selected.call);
          pendingCall = false;
          if (!goalChoiceAccepted(selected.value, Object.keys(choices)))
            return result(
              "value_abstention",
              uncertain(
                `value for ${field.name}`,
                selected.value,
                digest.version.route,
              ),
            );
          const id = selected.value.choice;
          if (id === "BLOCKED") return result("value_blocked");
          if (id.startsWith("use.")) key = id.slice(4);
          else {
            key = `generated_${generated.size + 1}`;
            while (key in data) key = `_${key}`;
            const value = new RuntimeValue(
              generators.generate(id),
              `{{${key}}}`,
            );
            data[key] = { value, sensitive: true, opaqueValues: [value] };
            taints.push(data[key]!);
            options.onGeneratedValue?.(value);
            generated.set(
              key,
              `${id} selected for ${describe(field)} on ${project(digest.version.route)} (not yet filled)`,
            );
          }
          pendingValue = { observation: valueObservation, index, key };
        }
        bindingKeys.set(head.choice, key);
        command = { ...command, value: data[key]!.value };
        targets.TYPE![head.choice] += ` ← {{${key}}}`;
      }
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
      if (generators && command.op === "type") {
        const valid = await active(
          page.evaluate<boolean>(`(({ ref, value }) => {
          const original = [...document.querySelectorAll('[data-sedum-ref]')].find(e => e.getAttribute('data-sedum-ref') === ref);
          if (!original) return false;
          const input = original.cloneNode(false);
          if (!('value' in input)) return true;
          input.value = value;
          return input.value === value &&
            (input.maxLength === undefined || input.maxLength < 0 || value.length <= input.maxLength) &&
            (input.minLength === undefined || input.minLength < 0 || value.length >= input.minLength) &&
            input.checkValidity();
        })(${JSON.stringify({ ref: chosen.ref, value: command.value.reveal() })})`),
        );
        if (!valid) return result("value_constraint_mismatch");
      }
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
      pendingValue = undefined;
      if (binding && generated.has(binding))
        generated.set(
          binding,
          `${generated.get(binding)!.replace(" (not yet filled)", "")}; filled ${describe(chosen)} on ${project(digest.version.route)}`,
        );
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
