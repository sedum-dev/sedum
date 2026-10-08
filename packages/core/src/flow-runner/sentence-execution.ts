import type { MeasureResult, VerifyResult } from "../assertion-engine.js";
import type { BrowserPage } from "../browser-driver.js";
import { LocatorCacheConflict } from "../cache-store.js";
import type { ClassifiedFlowSentence } from "../flow-classification.js";
import { executeAssertion } from "./assertions.js";
import {
  pendingTarget,
  performWithRecovery,
  refreshAfterQuiet,
} from "./action-recovery.js";
import {
  opaqueMatches,
  redactOpaqueText,
  resolveTypeOperand,
  validateTypeOperand,
  type ResolvedDataEntry,
} from "../flow-values.js";
import { resolveTarget, type LocatorResult } from "../locator.js";
import {
  LocateRetryError,
  reobserveLocator,
  unresolvedLocatorWhy,
} from "../locator/observation.js";
import type { VisionResolver } from "../vision.js";
import { chooseOption } from "../dropdown-option.js";
import {
  gotoPathParts,
  gotoUrlParts,
  historyMove,
  pressKey,
  scrollDirection,
  waitDurationMs,
  waitUntilTimeoutMs,
} from "../step-operands.js";
import { stageEntry } from "../page-cache.js";
import { pageVersion, quietPage, readTarget } from "../page-bridge.js";
import type { PageVersion } from "../page-protocol.js";
import {
  ProviderError,
  isRunWideProviderError,
  unknownCostCall,
  type ProviderCall,
} from "../provider.js";
import {
  safeSource,
  safeText,
  safeUrl,
  reportPage,
} from "../report-privacy.js";
import type {
  ResultCall,
  ResultFrame,
  ResultPage,
  ResultStep,
} from "../run-result.js";
import {
  RuntimeValue,
  RuntimeUrl,
  StepExecutionError,
  type ResolvedStepTarget,
  type StepCommand,
  executeStep,
} from "../step-executor.js";
import type { AttemptDependencies, FlowRunResult } from "./contracts.js";

import {
  firstDiagnostic,
  navigationWhy,
  providerFailure,
  resultCall,
  unsupported,
} from "./support.js";

/** How a script step is shown: its group path and, for extracts, its words. */
export interface SentencePresentation {
  readonly group?: readonly string[];
  readonly display?: string;
  /** A question the test branches on: judged once and never gating. */
  readonly check?: boolean;
}

/** @internal Execute one classified sentence and record it as one step. */
export async function executeSentence(
  page: BrowserPage,
  step: ClassifiedFlowSentence,
  dependencies: AttemptDependencies,
  data: Record<string, ResolvedDataEntry>,
  opaqueEntries: ResolvedDataEntry[],
  presentation: SentencePresentation = {},
): Promise<"continue" | "failed" | FlowRunResult> {
  const started = performance.now();
  const report = dependencies.report;
  const currentAttempt = report?.test.currentAttempt ?? undefined;
  const stepIndex = report ? (currentAttempt?.stepCount ?? 0) + 1 : 0;
  const attemptId = currentAttempt?.id ?? "";
  const stepId = `${attemptId}:step:${stepIndex}`;
  const sameVersion = (a: PageVersion, b: PageVersion) =>
    a.document === b.document &&
    a.route === b.route &&
    a.revision === b.revision;
  const capture = async (
    suffix: string,
    expectedVersion?: PageVersion,
  ): Promise<ResultFrame> => {
    if (!report || !page.captureFrame)
      return { status: "unavailable", reason: "capture_unavailable" };
    try {
      const before = await pageVersion(page);
      if (expectedVersion && !sameVersion(before, expectedVersion))
        return { status: "unavailable", reason: "stale_frame" };
      const bytes = await page.captureFrame();
      const after = await pageVersion(page);
      if (!sameVersion(before, after))
        return { status: "unavailable", reason: "stale_frame" };
      return await report.saveFrame(
        { id: attemptId, ordinal: currentAttempt?.ordinal ?? 1 },
        `${stepId}:${suffix}`,
        bytes,
      );
    } catch {
      return { status: "unavailable", reason: "capture_failed" };
    }
  };
  type StepFacts = {
    verify?: VerifyResult | MeasureResult;
    locator?: LocatorResult;
    error?: {
      code: string;
      message: string;
      callLog?: readonly string[] | undefined;
    };
    replayFrame?: ResultFrame | undefined;
    targetBox?: ResultStep["targetBox"];
    detail?: string;
    page?: ResultPage | undefined;
    failedCalls?: readonly ResultCall[];
  };
  const record = async <T extends "continue" | "failed" | FlowRunResult>(
    outcome: T,
    facts: StepFacts = {},
  ): Promise<T> => {
    if (!report) return outcome;
    const privacy = report.privacy;
    const locator = facts.locator;
    const acceptedVersion =
      facts.verify?.observationVersion ??
      (locator?.kind === "resolved"
        ? locator.target.driverTarget().version
        : locator?.diagnostic.observationVersion);
    const sensitive =
      (facts.page?.status === "omitted" &&
        facts.page.reason === "sensitive_page") ||
      (acceptedVersion !== undefined &&
        safeUrl(acceptedVersion.route, privacy).sensitive) ||
      safeUrl(page.url, privacy).sensitive;
    const isError =
      typeof outcome === "object" && outcome.status === "could_not_run";
    const failed =
      (outcome === "failed" && !presentation.check) ||
      (typeof outcome === "object" && outcome.status === "failed");
    const flags = facts.verify?.kind === "verify" ? facts.verify.flags : [];
    const needsEvidence = failed || isError || flags.length > 0;
    const evidence: ResultFrame = !needsEvidence
      ? { status: "omitted", reason: "clean_step" }
      : sensitive
        ? { status: "omitted", reason: "sensitive_page" }
        : !report.evidenceEnabled
          ? { status: "omitted", reason: "disabled" }
          : await capture("evidence", acceptedVersion);
    const replayFrame = !report.replay
      ? null
      : sensitive
        ? { status: "omitted" as const, reason: "sensitive_page" }
        : (facts.replayFrame ?? (await capture("replay", acceptedVersion)));
    // A check answers the test's question, so like a measure it has no verdict.
    const kind =
      step.op === "measure" || (step.op === "verify" && presentation.check)
        ? "measure"
        : step.op === "verify"
          ? "verify"
          : "action";
    const pageInfo =
      facts.page ??
      (await reportPage(
        page,
        `${stepId}:observation:1`,
        privacy,
        acceptedVersion,
      ));
    const calls = [
      ...(locator?.calls.map((call) => resultCall(call, "locator")) ?? []),
      ...(facts.failedCalls ?? []),
      ...(facts.verify
        ? [resultCall(facts.verify.call, "judge", facts.verify.elapsedMs)]
        : []),
    ];
    const policy = facts.verify?.kind === "verify" ? facts.verify : null;
    const judgement = facts.verify
      ? {
          holds: facts.verify.holds,
          contradicted: facts.verify.contradicted,
          threshold: policy?.minP ?? null,
          band: policy?.band ?? null,
          contradictionCutoff: policy?.contradictionCutoff ?? null,
          judgedExcerpt:
            !sensitive && facts.verify.judgedExcerpt
              ? safeText(facts.verify.judgedExcerpt, privacy, 1500)
              : null,
        }
      : null;
    const result: ResultStep = {
      id: stepId,
      index: stepIndex,
      kind,
      operation: step.op,
      phase: step.phase,
      sentence: safeText(presentation.display ?? step.text, privacy, 512),
      detail: safeText(facts.detail ?? "", privacy, 512),
      ...(presentation.group?.length
        ? {
            group: presentation.group.map((name) =>
              safeText(name, privacy, 120),
            ),
          }
        : {}),
      sourceStack: (step.sourceStack ?? [step.source]).map((source) =>
        safeSource(source, dependencies.repoRoot, privacy),
      ),
      state: isError ? "error" : "completed",
      verdict:
        isError || kind === "measure" ? null : failed ? "failed" : "passed",
      flags: [...flags],
      elapsedMs: performance.now() - started,
      page: pageInfo,
      locator: locator
        ? {
            confidence: locator.diagnostic.confidence ?? null,
            source:
              locator.cache?.outcome === "hit"
                ? "cache"
                : locator.kind === "resolved" && locator.calls.length
                  ? "model"
                  : "none",
            options: (sensitive
              ? []
              : locator.diagnostic.topOptions.slice(0, 5)
            ).map((option) => ({
              label: safeText(option.name, privacy, 120),
              role: safeText(option.role, privacy, 80),
              probability: option.probability,
            })),
            cache: locator.cache ?? null,
            ...(locator.diagnostic.vision
              ? { vision: locator.diagnostic.vision }
              : {}),
          }
        : null,
      judgement,
      observations: [
        {
          id: `${stepId}:observation:1`,
          ordinal: 1,
          elapsedMs: performance.now() - started,
          outcome: isError || failed ? "failed" : "accepted",
          reason: facts.error?.code ?? null,
          timeoutReason: null,
        },
      ],
      calls,
      error: facts.error
        ? {
            code: facts.error.code,
            message: safeText(facts.error.message, privacy, 512),
            ...(facts.error.callLog
              ? {
                  callLog: facts.error.callLog
                    .slice(0, 20)
                    .map((line) => safeText(line, privacy, 512)),
                }
              : {}),
          }
        : null,
      evidence,
      replayFrame,
      targetBox:
        replayFrame?.status === "captured" ? (facts.targetBox ?? null) : null,
    };
    await report.test.addStep(result);
    return outcome;
  };
  // A provider failure every later step would hit too is recorded on this
  // step with its real cause, then ends the attempt and the run.
  const runWide = async (
    error: ProviderError,
    facts: Pick<StepFacts, "failedCalls"> = {},
  ): Promise<ProviderError> => {
    const outcome = providerFailure(step.source.file, error);
    const modality =
      step.op === "verify" || step.op === "measure" ? "judge" : "locator";
    await record(outcome, {
      ...facts,
      failedCalls: [
        ...(facts.failedCalls ?? []),
        resultCall(unknownCostCall(error), modality),
      ],
      error: { code: outcome.code, message: outcome.message },
    });
    return error;
  };
  // Observe one settled DOM before locating/judging the next step. This avoids
  // treating the mutation from the previous action as a fresh locator target;
  // it does not retry or replay an action.
  const quiet = await quietPage(page, 80, 4_000).catch(() => ({
    quiet: false,
  }));
  // A wait polls the page itself, busy or not: that is what it waits through.
  const waits = step.op === "verify" && waitUntilTimeoutMs(step.text) !== null;
  if (!quiet.quiet && !waits)
    return record(
      unsupported(
        step.source.file,
        step.source,
        "The page did not settle before this step could be resolved.",
      ),
      {
        error: {
          code: "observation_timeout",
          message:
            "The page did not settle before this step could be resolved.",
        },
      },
    );
  let typeValue: RuntimeValue | undefined;
  if (step.op === "type") {
    const operand = validateTypeOperand(step);
    if ("diagnostic" in operand)
      return record(firstDiagnostic([operand.diagnostic]), {
        error: {
          code: operand.diagnostic.code,
          message: operand.diagnostic.message,
        },
      });
    try {
      typeValue = resolveTypeOperand(operand.operand, data);
    } catch {
      return record("failed", {
        error: {
          code: "missing_remembered_binding",
          message:
            "This step needs a value that is unavailable in this attempt.",
        },
      });
    }
  }
  if (step.op === "remember") {
    const targetLabel = presentation.display?.startsWith("extract ")
      ? "extract"
      : "remember";
    const match =
      /^(?:remember|capture)\s+(.+?)\s+as\s+\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*\.?$/iu.exec(
        step.text.trim(),
      );
    if (!match)
      return record(
        unsupported(
          step.source.file,
          step.source,
          "The remember target could not be understood.",
        ),
        {
          error: {
            code: "invalid_remember_target",
            message: "The remember target could not be understood.",
          },
        },
      );
    try {
      let remembered: string;
      let locator: LocatorResult | undefined;
      if (/^(?:the\s+)?page\s+text$/iu.test(match[1]!.trim())) {
        remembered = await page.text();
      } else {
        const locateRead = () =>
          resolveTarget(page, dependencies.provider, {
            operation: "read",
            sentence: match[1]!,
            projectText: (text) => redactOpaqueText(text, opaqueEntries),
            ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          });
        // A read right after a navigation races the page settling, exactly
        // as a click does; give it the same single fresh observation.
        locator = await reobserveLocator(page, await locateRead(), locateRead, {
          staleRetry: true,
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        });
        if (locator.kind !== "resolved")
          return record("failed", {
            locator,
            error: {
              code: locator.reason,
              message: `The ${targetLabel} target could not be resolved.`,
            },
          });
        let read = await readTarget(page, locator.target.driverTarget());
        // A DOM revision can land after the locator's freshness check but
        // before the read. Resolve from a new snapshot once; never reuse the
        // stale ref or relax the page script's identity/version guards.
        if (read.status === "stale") {
          locator = await reobserveLocator(
            page,
            { ...locator, kind: "unresolved", reason: "stale" },
            locateRead,
            {
              staleRetry: true,
              ...(dependencies.signal ? { signal: dependencies.signal } : {}),
            },
          );
          if (locator.kind === "resolved")
            read = await readTarget(page, locator.target.driverTarget());
        }
        if (read.status !== "ok")
          return record("failed", {
            locator,
            error: {
              code: `remember_${read.status}`,
              message: `The ${targetLabel} target did not contain usable text.`,
            },
          });
        remembered = read.text;
      }
      if (!remembered.trim() || Array.from(remembered).length > 4096)
        return record("failed", {
          ...(locator ? { locator } : {}),
          error: {
            code: "remember_invalid_text",
            message: `The ${targetLabel} target did not contain usable text.`,
          },
        });
      const echoedSecrets = opaqueMatches(remembered, opaqueEntries);
      const sensitivePage = report
        ? safeUrl(page.url, report.privacy).sensitive
        : false;
      const opaqueValues = sensitivePage
        ? [...echoedSecrets, new RuntimeValue(remembered, `{{${match[2]!}}}`)]
        : echoedSecrets;
      // Public page text stays readable in reports; only a value read from a
      // sensitive page, or one echoing a known secret, is treated as secret.
      const secret = opaqueValues.length > 0;
      data[match[2]!] = {
        value: new RuntimeValue(remembered, `{{${match[2]!}}}`),
        sensitive: secret,
        modelVisible: !secret,
        opaqueValues,
      };
      opaqueEntries.push(data[match[2]!]!);
      if (secret) report?.privacy.secretValues.push(remembered);
      return record("continue", locator ? { locator } : {});
    } catch (error) {
      if (isRunWideProviderError(error)) throw await runWide(error);
      return record(
        unsupported(
          step.source.file,
          step.source,
          "The target text could not be remembered.",
        ),
        {
          error: {
            code: "remember_error",
            message: "The target text could not be remembered.",
          },
        },
      );
    }
  }
  if (step.op === "verify" || step.op === "measure") {
    return executeAssertion({
      page,
      step,
      dependencies,
      data,
      opaqueEntries,
      check: presentation.check ?? false,
      record,
      runWide,
      reobserve: (first, locate) =>
        reobserveLocator(page, first, locate, {
          staleRetry: true,
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        }),
    });
  }

  if (
    step.op === "wait" ||
    step.op === "press" ||
    step.op === "scroll" ||
    step.op === "goto"
  ) {
    let command: StepCommand;
    let detail = "";
    const invalid = (message: string) =>
      record(
        {
          status: "could_not_run",
          file: step.source.file,
          code: "invalid_test",
          source: step.source,
          message,
        },
        { error: { code: "invalid_operand", message } },
      );
    if (step.op === "wait") {
      const durationMs = waitDurationMs(step.text);
      if (durationMs === null)
        return invalid("Use a positive wait duration of at most 30 seconds.");
      command = { op: "wait", durationMs };
    } else if (step.op === "press") {
      const key = pressKey(step.text);
      if (key === null)
        return invalid(
          'Name one key to press, such as Enter, Tab, Escape, or "Control+A".',
        );
      command = { op: "press", key };
      detail = `Pressed ${key}.`;
    } else if (step.op === "scroll") {
      const direction = scrollDirection(step.text);
      if (direction === null) return invalid("Say scroll up or scroll down.");
      // One screenful, keeping some overlap so content is not skipped.
      const height = await page
        .evaluate<number>("window.innerHeight")
        .catch(() => 800);
      const deltaY = Math.round(Math.max(200, height * 0.8));
      command = {
        op: "scroll",
        deltaY: direction === "down" ? deltaY : -deltaY,
      };
    } else {
      const move = historyMove(step.text);
      const path = move ? null : gotoPathParts(step.text);
      let origin = "";
      if (path) {
        try {
          origin = new URL(page.url).origin;
        } catch {
          return invalid("A /path needs a page on a site to start from.");
        }
        if (!/^https?:/u.test(origin))
          return invalid("A /path needs a page on a site to start from.");
      }
      const parts = move
        ? null
        : path
          ? {
              ...path,
              literals: [origin + path.literals[0]!, ...path.literals.slice(1)],
            }
          : gotoUrlParts(step.text);
      if (move) {
        command = { op: "history", move };
        detail =
          move === "reload" ? "Reloaded the page." : `Went ${move} in history.`;
      } else if (parts === null)
        return invalid(
          "Name exactly one http(s) address or a /path on this site.",
        );
      else {
        const values = parts.names.map((name) => data[name]?.value);
        if (values.some((value) => value === undefined))
          return record("failed", {
            error: {
              code: "missing_remembered_binding",
              message:
                "This step needs a value that is unavailable in this attempt.",
            },
          });
        const url = new RuntimeUrl(parts.literals, values as RuntimeValue[]);
        try {
          new URL(url.reveal());
        } catch {
          return invalid("The goto address is not a valid URL.");
        }
        command = { op: "goto", url };
        detail = `Opened ${url.toString()}.`;
      }
    }
    try {
      await executeStep(page, command, {
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      });
      return record("continue", detail ? { detail } : {});
    } catch (error) {
      const actionError = error instanceof StepExecutionError ? error : null;
      const facts = {
        error: {
          code: actionError?.code ?? "action_error",
          message: actionError?.message ?? "The action could not complete.",
          callLog: actionError?.callLog,
        },
      };
      return actionError?.code === "invalid_input"
        ? record("failed", facts)
        : record(
            unsupported(
              step.source.file,
              step.source,
              actionError?.op === "goto"
                ? `Could not open the address: ${navigationWhy(actionError)}.`
                : `The ${step.op} step could not complete.`,
            ),
            facts,
          );
    }
  }
  const typeOperand = step.op === "type" ? validateTypeOperand(step) : null;
  const runtimeDependent = step.tokens.some(
    (token) =>
      token.kind === "placeholder" &&
      (step.op === "click" ||
        !typeOperand ||
        "diagnostic" in typeOperand ||
        token.start < typeOperand.operand.start ||
        token.end > typeOperand.operand.end),
  );
  const cacheSentence =
    step.op === "type" && typeOperand && "operand" in typeOperand
      ? `${step.text.slice(0, typeOperand.operand.start)}${step.text.slice(typeOperand.operand.end)}`
          .replace(/\s+/gu, " ")
          .trim()
      : step.text;
  let visionAttempted = false;
  const locate = (signal = dependencies.signal, timeoutMs?: number) =>
    resolveTarget(page, dependencies.provider, {
      // Disabling transmission or exhausting the request budget must not
      // restore permissive repeated-member picks.
      ...(dependencies.visionResolver && step.op === "click"
        ? { repeatedMember: {} }
        : {}),
      ...(dependencies.visionResolver &&
      !visionAttempted &&
      !(report && safeUrl(page.url, report.privacy).sensitive)
        ? {
            visionResolver: {
              choose: (...args: Parameters<VisionResolver["choose"]>) => {
                visionAttempted = true;
                return dependencies.visionResolver!.choose(...args);
              },
            },
          }
        : {}),
      operation: step.op === "type" ? "fill" : "click",
      sentence: step.text,
      cacheSentence,
      runtimeDependent,
      ...(dependencies.locatorCache
        ? { cache: dependencies.locatorCache }
        : {}),
      projectText: (text) => redactOpaqueText(text, opaqueEntries),
      ...(signal ? { signal } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  let resolved: LocatorResult;
  try {
    resolved = await locate();
  } catch (error) {
    if (isRunWideProviderError(error)) throw await runWide(error);
    return record(
      unsupported(
        step.source.file,
        step.source,
        "The target could not be resolved.",
      ),
      {
        error: {
          code: "locator_error",
          message: "The target could not be resolved.",
        },
      },
    );
  }
  try {
    resolved = await reobserveLocator(page, resolved, locate, {
      staleRetry: !visionAttempted,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
  } catch (error) {
    if (isRunWideProviderError(error)) throw await runWide(error);
    if (!(error instanceof LocateRetryError)) throw error;
    return record(
      unsupported(
        step.source.file,
        step.source,
        "The target could not be resolved.",
      ),
      {
        failedCalls: error.priorCalls.map((call) =>
          resultCall(call, "locator"),
        ),
        error: {
          code: "locator_error",
          message: "The target could not be resolved.",
        },
      },
    );
  }
  // Like Playwright's auto-wait: a target that is not on the page yet may
  // appear while the page is still changing. Locate again after each change,
  // within the same grace a verify gets; a page that stays put costs nothing.
  const missing = (result: LocatorResult) =>
    !visionAttempted && pendingTarget(result);
  const actionGraceMs = dependencies.verifyGraceMs ?? 0;
  if (missing(resolved) && actionGraceMs > 0) {
    const deadline = performance.now() + actionGraceMs;
    const earlier: ProviderCall[] = [];
    while (
      missing(resolved) &&
      performance.now() < deadline &&
      !dependencies.signal?.aborted
    ) {
      const before =
        (resolved.kind !== "resolved"
          ? resolved.diagnostic.observationVersion
          : undefined) ?? (await pageVersion(page).catch(() => null));
      let changed = false;
      while (performance.now() < deadline) {
        if (dependencies.signal?.aborted) break;
        const now = await pageVersion(page).catch(() => null);
        if (
          !before ||
          !now ||
          now.revision !== before.revision ||
          now.document !== before.document ||
          now.route !== before.route
        ) {
          changed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!changed) break;
      await quietPage(page, 80, 2_000).catch(() => undefined);
      earlier.push(...resolved.calls);
      try {
        resolved = await locate();
      } catch (error) {
        if (isRunWideProviderError(error)) {
          const failedCalls = earlier.map((call) =>
            resultCall(call, "locator"),
          );
          throw await runWide(error, { failedCalls });
        }
        break;
      }
    }
    if (earlier.length)
      resolved = { ...resolved, calls: [...earlier, ...resolved.calls] };
  }
  if (dependencies.signal?.aborted)
    return record(
      unsupported(
        step.source.file,
        step.source,
        "The target could not be resolved because the run was canceled.",
      ),
      {
        locator: resolved,
        error: {
          code: "canceled",
          message:
            "The target could not be resolved because the run was canceled.",
        },
      },
    );
  if (resolved.kind !== "resolved") {
    if (
      resolved.reason === "none" ||
      resolved.reason === "ambiguous" ||
      resolved.reason === "no_candidates"
    )
      return record("failed", {
        locator: resolved,
        error: {
          // "none" reads like "no error"; say what happened.
          code: resolved.reason === "none" ? "no_match" : resolved.reason,
          message: `Could not resolve this ${step.op} step: ${unresolvedLocatorWhy(
            resolved,
            step.op,
            Boolean(dependencies.visionResolver) && step.op === "click",
          )}.`,
        },
      });
    return record(
      unsupported(
        step.source.file,
        step.source,
        `Could not resolve this ${step.op} step (${resolved.reason}).`,
      ),
      {
        locator: resolved,
        error: {
          code: resolved.reason,
          message: `Could not resolve this ${step.op} step.`,
        },
      },
    );
  }
  let chosenOption: string | null = null;
  const commandFor = (target: ResolvedStepTarget): StepCommand =>
    step.op === "click"
      ? {
          op: "click",
          target,
          chooseOption: (labels) =>
            (chosenOption = chooseOption(step.text, labels)),
        }
      : { op: "type", target, value: typeValue! };
  let command = commandFor(resolved.target);
  // An action may navigate or rerender. Preserve metadata from the accepted
  // locator observation before dispatch, rather than borrowing the new page.
  let locatedPage = report
    ? await reportPage(
        page,
        `${stepId}:observation:1`,
        report.privacy,
        resolved.target.driverTarget().version,
      )
    : undefined;
  let replayFrame: ResultFrame | undefined;
  let targetBox: ResultStep["targetBox"] = null;
  const performAction = (timeoutMs: number) =>
    executeStep(page, command, {
      timeoutMs,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      ...(report?.replay
        ? {
            beforeAction: async (
              box: ResultStep["targetBox"] | undefined,
              aimVersion: PageVersion,
            ) => {
              if (
                safeUrl(aimVersion.route, report.privacy).sensitive ||
                safeUrl(page.url, report.privacy).sensitive
              ) {
                replayFrame = { status: "omitted", reason: "sensitive_page" };
                return;
              }
              const frame = await capture("replay", aimVersion);
              replayFrame = frame;
              targetBox = frame.status === "captured" ? (box ?? null) : null;
            },
          }
        : {}),
    });
  try {
    let observation = 1;
    await performWithRecovery({
      op: step.op,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      perform: performAction,
      allowed: () => !visionAttempted,
      refresh: async (remainingMs, signal) => {
        const priorCalls = resolved.calls;
        replayFrame = undefined;
        targetBox = null;
        const retried = await refreshAfterQuiet(
          page,
          remainingMs,
          signal,
          locate,
        );
        if (!retried) return false;
        if (retried.kind !== "resolved") {
          resolved = { ...resolved, calls: [...priorCalls, ...retried.calls] };
          if (
            ![
              "stale",
              "none",
              "no_candidates",
              "ambiguous",
              "timeout",
            ].includes(retried.reason)
          )
            throw new Error("The target could not be resolved.");
          return false;
        }
        resolved = { ...retried, calls: [...priorCalls, ...retried.calls] };
        command = commandFor(resolved.target);
        locatedPage = report
          ? await reportPage(
              page,
              `${stepId}:observation:${++observation}`,
              report.privacy,
              resolved.target.driverTarget().version,
            )
          : undefined;
        replayFrame = undefined;
        targetBox = null;
        return true;
      },
    });
    let recordedLocator = resolved;
    if (resolved.cacheSeed && dependencies.locatorCache?.key) {
      const seed = resolved.cacheSeed;
      try {
        const entry = stageEntry(
          dependencies.locatorCache.key,
          seed.eligible.version.route,
          step.op === "type" ? "fill" : "click",
          cacheSentence,
          seed.candidate,
          seed.eligible,
        );
        await dependencies.locatorCache.put(seed.key, entry);
      } catch (error) {
        // A target that cannot be told apart safely is never stored, so an
        // "absent" miss would wrongly suggest the next run will hit.
        if (
          error instanceof Error &&
          error.message === "candidate_not_distinguishable" &&
          resolved.cache?.reason === "absent"
        )
          recordedLocator = {
            ...resolved,
            cache: { ...resolved.cache, reason: "not_cacheable" },
          };
        else if (
          error instanceof Error &&
          error.message !== "candidate_not_distinguishable" &&
          resolved.cache
        )
          recordedLocator = {
            ...resolved,
            cache: {
              ...resolved.cache,
              reason:
                error instanceof LocatorCacheConflict
                  ? "conflict"
                  : "storage_error",
            },
          };
      }
    }
    return record("continue", {
      locator: recordedLocator,
      replayFrame,
      targetBox,
      page: locatedPage,
      ...(chosenOption === null
        ? {}
        : { detail: `Chose "${chosenOption}" in the dropdown.` }),
    });
  } catch (error) {
    if (isRunWideProviderError(error)) throw await runWide(error);
    const actionError = error instanceof StepExecutionError ? error : null;
    const failed =
      actionError &&
      (actionError.code === "not_actionable" ||
        actionError.code === "invalid_input");
    const facts = {
      locator: resolved,
      replayFrame,
      targetBox,
      page: locatedPage,
      error: {
        code: actionError?.code ?? "action_error",
        message: actionError?.message ?? "The action could not complete.",
        callLog: actionError?.callLog,
      },
    };
    return failed
      ? record("failed", facts)
      : record(
          unsupported(
            step.source.file,
            step.source,
            "The action could not complete.",
          ),
          facts,
        );
  }
}
