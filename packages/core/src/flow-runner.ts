import path from "node:path";
import {
  AssertionEngineError,
  DEFAULT_MIN_P,
  DEFAULT_BAND,
  DEFAULT_CONTRADICTION_CUTOFF,
  measure,
  verify,
  type MeasureResult,
  type VerifyPolicy,
  type VerifyResult,
} from "./assertion-engine.js";
import {
  BrowserDriverError,
  type BrowserDriver,
  type BrowserKind,
  type BrowserPage,
  type BrowserSession,
} from "./browser-driver.js";
import type {
  ClassificationCache,
  ClassificationProvider,
} from "./classification.js";
import { LocatorCacheConflict, type CacheStore } from "./cache-store.js";
import {
  classifyParsedFlow,
  type ClassifiedFlowSentence,
  type ClassifiedFlowStep,
} from "./flow-classification.js";
import { loadFlowFile } from "./flow-loader.js";
import { runGoal, type GoalPlanner, type GoalAction } from "./goal-runner.js";
import { resolveFlowModules } from "./flow-modules.js";
import {
  ModuleBindingResolutionError,
  opaqueMatches,
  redactOpaqueText,
  resolveData,
  resolveModuleBindings,
  resolveTypeOperand,
  validateTypeOperand,
  type ResolvedDataEntry,
} from "./flow-values.js";
import type { FlowDiagnostic, FlowSource } from "./flow-types.js";
import { resolveTarget, type LocatorResult } from "./locator.js";
import type { VisionResolver } from "./vision.js";
import { chooseOption } from "./dropdown-option.js";
import {
  gotoUrlParts,
  pressKey,
  scrollDirection,
  waitDurationMs,
} from "./step-operands.js";
import { stageEntry } from "./page-cache.js";
import { pageVersion, quietPage, readTarget } from "./page-bridge.js";
import type { PageVersion } from "./page-protocol.js";
import {
  ProviderError,
  isRunWideProviderError,
  type Judge,
  type ProviderCall,
  type Resolver,
} from "./provider.js";
import {
  safeSource,
  safeText,
  safeUrl,
  reportPage,
  type ReportPrivacy,
} from "./report-privacy.js";
import type {
  ResultCall,
  ResultFrame,
  ResultPage,
  ResultStep,
} from "./run-result.js";
import type { RunRecorder, TestRecording } from "./run-recorder.js";
import {
  RuntimeValue,
  RuntimeUrl,
  StepExecutionError,
  type ResolvedStepTarget,
  type StepCommand,
  executeStep,
} from "./step-executor.js";

export type FlowRunResult =
  | { readonly status: "passed"; readonly file: string }
  | {
      readonly status: "failed";
      readonly file: string;
      readonly source: FlowSource;
      /** Goal failures must not restart autonomous actions through CLI retries. */
      readonly retryable?: false;
    }
  | {
      readonly status: "could_not_run";
      readonly file: string;
      readonly code: string;
      readonly message: string;
      readonly source?: FlowSource;
      readonly fix?: string;
    };

/** Dependencies are injected so the engine never owns process state or SDK types. */
export interface FlowRunnerDependencies {
  readonly repoRoot: string;
  /** Parallel lanes pass a `ReusableBrowserDriver` so attempts share one browser. */
  readonly browser: BrowserDriver;
  readonly provider: ClassificationProvider &
    Resolver &
    Judge &
    Partial<GoalPlanner>;
  readonly visionResolver?: VisionResolver;
  readonly classificationCache: ClassificationCache;
  readonly locatorCache?: CacheStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Temporary debug switch; the final CLI/config surface owns launch policy. */
  readonly headless?: boolean;
  readonly browserKind?: BrowserKind;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly verifyPolicy?: VerifyPolicy;
  readonly baseUrl?: string;
  readonly urlOverride?: string;
  readonly slowMoMs?: number;
  readonly headedOverlay?: boolean;
  readonly signal?: AbortSignal;
  readonly report?: {
    readonly recorder: RunRecorder;
    /**
     * Selection position and lane for parallel runs. Without it the runner
     * treats the most recently started test as the one being retried.
     */
    readonly slot?: { readonly ordinal: number; readonly lane?: number };
    readonly privacy: ReportPrivacy;
    readonly evidenceEnabled: boolean;
    readonly replay: boolean;
    /** Stores one frame under its attempt; `frameId` is unique within the run. */
    readonly saveFrame: (
      attempt: { readonly id: string; readonly ordinal: number },
      frameId: string,
      bytes: Uint8Array,
    ) => Promise<ResultFrame>;
  };
}

type RunReport = NonNullable<FlowRunnerDependencies["report"]>;

/** One attempt's report: its own test handle and its own privacy state. */
type AttemptReport = Omit<RunReport, "recorder" | "slot"> & {
  readonly test: TestRecording;
};

type AttemptDependencies = Omit<FlowRunnerDependencies, "report"> & {
  readonly report?: AttemptReport;
};

function resultCall(
  call: ProviderCall,
  purpose: ResultCall["purpose"],
  apiMs: number | null = null,
): ResultCall {
  return {
    purpose,
    ...(call.modality ? { modality: call.modality } : {}),
    requestedModel: call.requestedModel,
    model: call.model,
    attempts: call.attempts,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    apiMs,
    inputUsdPerMillion: call.rate?.inputUsdPerMillion ?? null,
    outputUsdPerMillion: call.rate?.outputUsdPerMillion ?? null,
    rateSource: call.rate?.source ?? null,
    rateCheckedAt: call.rate?.checkedAt ?? null,
    costUsd: call.totalCostUsd,
    ...(call.rateLimited ? { rateLimited: true } : {}),
    ...(call.rateLimitWaitMs ? { rateLimitWaitMs: call.rateLimitWaitMs } : {}),
    ...(call.queueWaitMs ? { queueWaitMs: call.queueWaitMs } : {}),
  };
}

function firstDiagnostic(
  diagnostics: readonly FlowDiagnostic[],
): FlowRunResult {
  const diagnostic = diagnostics.find((item) => item.severity === "error");
  return {
    status: "could_not_run",
    file: diagnostic?.source.file ?? "",
    code: "invalid_test",
    message: diagnostic?.message ?? "The test file could not be validated.",
    ...(diagnostic?.fix ? { fix: diagnostic.fix } : {}),
    ...(diagnostic ? { source: diagnostic.source } : {}),
  };
}

function unsupported(
  file: string,
  source: FlowSource,
  message: string,
): FlowRunResult {
  return {
    status: "could_not_run",
    file,
    code: "unsupported_test",
    source,
    message,
  };
}

function runtimeFailure(file: string, error: unknown): FlowRunResult {
  if (error instanceof BrowserDriverError) {
    const details: Record<
      typeof error.code,
      { readonly message: string; readonly fix: string }
    > = {
      "browser-missing": {
        message: "No supported browser binary was found.",
        fix: "Run `sedum browsers install chromium`, then rerun the test.",
      },
      "browser-launch-failed": {
        message: "The browser could not be started safely.",
        fix: "Check the browser installation and permissions, then rerun the test.",
      },
      "browser-disconnected": {
        message: "The browser disconnected during the run.",
        fix: "Restart the browser run and check browser stability if it repeats.",
      },
      "context-closed": {
        message: "The browser context closed during the run.",
        fix: "Rerun the test and check browser stability if it repeats.",
      },
      "page-closed": {
        message: "The browser page closed during the run.",
        fix: "Rerun the test and check whether the tested page closes itself.",
      },
      "page-crashed": {
        message: "The browser page crashed during the run.",
        fix: "Rerun the test and check browser resource usage if it repeats.",
      },
      "operation-failed": {
        message: "A browser operation could not be completed safely.",
        fix: "Check the named test step and rerun the test.",
      },
      "script-missing": {
        message: "The Sedum browser script was unavailable.",
        fix: "Rebuild or reinstall Sedum, then rerun the test.",
      },
    };
    return {
      status: "could_not_run",
      file,
      code: error.code,
      ...details[error.code],
    };
  }
  if (error instanceof ProviderError) {
    if (error.code === "rate-limited")
      return {
        status: "could_not_run",
        file,
        code: "provider_rate_limited",
        message: "The provider kept rate limiting requests for five minutes.",
        fix: "Lower --parallel or --provider-concurrency, or retry later.",
      };
    return {
      status: "could_not_run",
      file,
      code: `provider_${error.code}`,
      message: "The model provider could not complete the run safely.",
      fix:
        error.code === "configuration" || error.code === "authentication"
          ? "Check the configured provider API key and access, then rerun the test."
          : "Check provider availability and the test input, then rerun the test.",
    };
  }
  return {
    status: "could_not_run",
    file,
    code: "execution_error",
    message: "The browser run could not be completed safely.",
    fix: "Check the browser, provider, and test input, then rerun the test.",
  };
}

function claim(
  step: ClassifiedFlowSentence,
  data: Readonly<Record<string, ResolvedDataEntry>>,
): string {
  return step.text
    .replace(
      /^\s*(?:verify|assert|check|confirm|ensure|expect|measure|note|observe)\b\s*(?:that\s+|whether\s+|if\s+)?/iu,
      "",
    )
    .trim()
    .replace(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
      (placeholder, key: string) =>
        data[key]?.modelVisible ? data[key].value.reveal() : placeholder,
    );
}

/** SED-10 entry URL semantics; SED-33 adds origin-preserving --url-override. */
export function resolveEntryUrl(
  testUrl?: string,
  baseUrl?: string,
  urlOverride?: string,
): string {
  let override: URL | undefined;
  if (urlOverride) {
    override = new URL(urlOverride);
    if (!["http:", "https:"].includes(override.protocol))
      throw new Error("The URL override must use HTTP or HTTPS.");
  }
  let resolved: URL;
  if (testUrl) {
    try {
      resolved = baseUrl ? new URL(testUrl, baseUrl) : new URL(testUrl);
    } catch {
      throw new Error(
        baseUrl
          ? "The test URL is invalid relative to the configured baseUrl."
          : "The test URL is relative but no baseUrl is configured.",
      );
    }
  } else if (baseUrl) resolved = new URL(baseUrl);
  else throw new Error("The test has no URL and no baseUrl is configured.");
  if (override) {
    resolved.protocol = override.protocol;
    resolved.host = override.host;
    resolved.username = override.username;
    resolved.password = override.password;
  }
  return resolved.href;
}

async function closeQuietly(resource: { close(): Promise<void> } | undefined) {
  await resource?.close().catch(() => undefined);
}

/** A fresh resolution threw; carries the calls already made for the report. */
class LocateRetryError extends Error {
  constructor(readonly priorCalls: readonly ProviderCall[]) {
    super("The target could not be resolved.");
  }
}

/**
 * Re-observe a resolution that failed only because the page moved under it.
 * Nothing has been acted on yet, so a fresh read is safe for any operation.
 */
async function reobserve(
  page: BrowserPage,
  first: LocatorResult,
  locate: () => Promise<LocatorResult>,
  options: { readonly staleRetry: boolean; readonly signal?: AbortSignal },
): Promise<LocatorResult> {
  let resolved = first;
  // A resolver response can arrive during an unrelated DOM revision. One fresh
  // read after a longer quiet period is safe: it reuses neither a target nor a
  // prior action.
  if (
    options.staleRetry &&
    resolved.kind === "unresolved" &&
    resolved.reason === "stale"
  ) {
    const priorCalls = resolved.calls;
    const settled = await quietPage(page, 1_000, 4_000).catch(() => ({
      quiet: false,
    }));
    if (settled.quiet) {
      try {
        const retried = await locate();
        resolved = { ...retried, calls: [...priorCalls, ...retried.calls] };
      } catch (error) {
        if (isRunWideProviderError(error)) throw error;
        throw new LocateRetryError(priorCalls);
      }
    }
  }
  // A navigation can briefly leave a quiet, empty document before the real
  // page commits. Re-observe only an empty candidate set within a deadline;
  // no model choice or action has happened, and an actually empty page still
  // ends with no_candidates.
  if (resolved.kind === "unresolved" && resolved.reason === "no_candidates") {
    const deadline = performance.now() + 8_000;
    while (performance.now() < deadline && !options.signal?.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      const settled = await quietPage(page, 80, 1_000).catch(() => ({
        quiet: false,
      }));
      if (!settled.quiet) continue;
      try {
        const fresh = await locate();
        resolved = { ...fresh, calls: [...resolved.calls, ...fresh.calls] };
        if (
          resolved.kind !== "unresolved" ||
          resolved.reason !== "no_candidates"
        )
          break;
      } catch (error) {
        if (isRunWideProviderError(error)) throw error;
        // A redirect can invalidate the read-only execution context.
      }
    }
  }
  return resolved;
}

async function executeSentence(
  page: BrowserPage,
  step: ClassifiedFlowSentence,
  dependencies: AttemptDependencies,
  data: Record<string, ResolvedDataEntry>,
  opaqueEntries: ResolvedDataEntry[],
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
      outcome === "failed" ||
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
    const kind =
      step.op === "verify"
        ? "verify"
        : step.op === "measure"
          ? "measure"
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
      sentence: safeText(step.text, privacy, 512),
      detail: safeText(facts.detail ?? "", privacy, 512),
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
  // Observe one settled DOM before locating/judging the next step. This avoids
  // treating the mutation from the previous action as a fresh locator target;
  // it does not retry or replay an action.
  const quiet = await quietPage(page, 80, 4_000).catch(() => ({
    quiet: false,
  }));
  if (!quiet.quiet)
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
        locator = await reobserve(page, await locateRead(), locateRead, {
          staleRetry: true,
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        });
        if (locator.kind !== "resolved")
          return record("failed", {
            locator,
            error: {
              code: locator.reason,
              message: "The remember target could not be resolved.",
            },
          });
        const read = await readTarget(page, locator.target.driverTarget());
        if (read.status !== "ok")
          return record("failed", {
            locator,
            error: {
              code: `remember_${read.status}`,
              message: "The remember target did not contain usable text.",
            },
          });
        remembered = read.text;
      }
      if (!remembered.trim() || Array.from(remembered).length > 4096)
        return record("failed", {
          ...(locator ? { locator } : {}),
          error: {
            code: "remember_invalid_text",
            message: "The remember target did not contain usable text.",
          },
        });
      const echoedSecrets = opaqueMatches(remembered, opaqueEntries);
      const sensitivePage = report
        ? safeUrl(page.url, report.privacy).sensitive
        : false;
      const opaqueValues = sensitivePage
        ? [...echoedSecrets, new RuntimeValue(remembered, `{{${match[2]!}}}`)]
        : echoedSecrets;
      data[match[2]!] = {
        value: new RuntimeValue(remembered, `{{${match[2]!}}}`),
        sensitive: true,
        modelVisible: opaqueValues.length === 0,
        opaqueValues,
      };
      opaqueEntries.push(data[match[2]!]!);
      report?.privacy.secretValues.push(remembered);
      return record("continue", locator ? { locator } : {});
    } catch (error) {
      if (isRunWideProviderError(error)) throw error;
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
    const assertion = {
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      projectText: (text: string) => redactOpaqueText(text, opaqueEntries),
    };
    // A measure records both scores and never gates the test.
    const judge = (): Promise<VerifyResult | MeasureResult> =>
      step.op === "measure"
        ? measure(page, dependencies.provider, claim(step, data), assertion)
        : verify(page, dependencies.provider, claim(step, data), {
            ...assertion,
            ...(dependencies.verifyPolicy ?? {}),
          });
    const outcome = (result: VerifyResult | MeasureResult) =>
      result.kind === "verify" && result.verdict === "failed"
        ? "failed"
        : "continue";
    try {
      const result = await judge();
      // The Judge is read-only. If its evidence went stale during the provider
      // request, take exactly one fresh settled observation rather than
      // reporting a verdict about an old page.
      return record(outcome(result), {
        verify: result,
      });
    } catch (error) {
      if (isRunWideProviderError(error)) throw error;
      const priorCalls =
        error instanceof AssertionEngineError && error.failedCall
          ? [resultCall(error.failedCall, "judge")]
          : [];
      if (
        error instanceof AssertionEngineError &&
        error.code === "stale_observation"
      ) {
        const settled = await quietPage(page, 80, 4_000).catch(() => ({
          quiet: false,
        }));
        if (settled.quiet) {
          try {
            const result = await judge();
            return record(outcome(result), {
              verify: result,
              failedCalls: priorCalls,
            });
          } catch (retryError) {
            if (isRunWideProviderError(retryError)) throw retryError;
            return record(
              unsupported(
                step.source.file,
                step.source,
                retryError instanceof Error
                  ? retryError.message
                  : "The assertion could not be judged.",
              ),
              {
                failedCalls:
                  retryError instanceof AssertionEngineError &&
                  retryError.failedCall
                    ? [
                        ...priorCalls,
                        resultCall(retryError.failedCall, "judge"),
                      ]
                    : priorCalls,
                error: {
                  code:
                    retryError instanceof AssertionEngineError
                      ? retryError.code
                      : "assertion_error",
                  message: "The assertion could not be judged.",
                },
              },
            );
          }
        }
      }
      return record(
        unsupported(
          step.source.file,
          step.source,
          error instanceof Error
            ? error.message
            : "The assertion could not be judged.",
        ),
        {
          failedCalls: priorCalls,
          error: {
            code:
              error instanceof AssertionEngineError
                ? error.code
                : "assertion_error",
            message: "The assertion could not be judged.",
          },
        },
      );
    }
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
      const parts = gotoUrlParts(step.text);
      if (parts === null) return invalid("Name exactly one http(s) address.");
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
              `The ${step.op} step could not complete.`,
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
  const locate = () =>
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
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
  let resolved: LocatorResult;
  try {
    resolved = await locate();
  } catch (error) {
    if (isRunWideProviderError(error)) throw error;
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
    resolved = await reobserve(page, resolved, locate, {
      staleRetry: !visionAttempted,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
  } catch (error) {
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
  if (resolved.kind !== "resolved") {
    if (
      resolved.reason === "none" ||
      resolved.reason === "ambiguous" ||
      resolved.reason === "no_candidates"
    )
      return record("failed", {
        locator: resolved,
        error: {
          code: resolved.reason,
          message: resolved.diagnostic.vision?.failure
            ? `Could not resolve this ${step.op} step: vision ${resolved.diagnostic.vision.failure}${resolved.diagnostic.vision.httpStatus ? ` (HTTP ${resolved.diagnostic.vision.httpStatus})` : ""}.`
            : dependencies.visionResolver &&
                step.op === "click" &&
                !resolved.diagnostic.vision
              ? `Could not resolve this ${step.op} step. Vision fallback was not tried: ${
                  resolved.reason === "none"
                    ? "the text model found no matching element, and vision only breaks ties between repeated controls"
                    : resolved.reason === "no_candidates"
                      ? "the page offered no clickable elements"
                      : "it needs at least two visible, repeated controls to choose between"
                }.`
              : `Could not resolve this ${step.op} step.`,
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
  const performAction = () =>
    executeStep(page, command, {
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
    try {
      await performAction();
    } catch (error) {
      if (
        !(error instanceof StepExecutionError) ||
        error.code !== "stale" ||
        !error.retryable ||
        visionAttempted
      )
        throw error;
      // The first attempt provably did not dispatch input. Re-observe and
      // resolve against the current page once; never replay an uncertain act.
      const priorCalls = resolved.calls;
      replayFrame = undefined;
      targetBox = null;
      const quiet = await quietPage(page, 80, 4_000).catch(() => ({
        quiet: false,
      }));
      if (!quiet.quiet) throw error;
      const retried = await locate();
      if (retried.kind !== "resolved") {
        resolved = { ...resolved, calls: [...priorCalls, ...retried.calls] };
        throw error;
      }
      resolved = { ...retried, calls: [...priorCalls, ...retried.calls] };
      command = commandFor(resolved.target);
      locatedPage = report
        ? await reportPage(
            page,
            `${stepId}:observation:2`,
            report.privacy,
            resolved.target.driverTarget().version,
          )
        : undefined;
      replayFrame = undefined;
      targetBox = null;
      await performAction();
    }
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
        if (
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
    if (isRunWideProviderError(error)) throw error;
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

/** Goal replay frames show the resulting page, never a stale pre-action target box. */
async function recordGoalAction(
  page: BrowserPage,
  action: GoalAction,
  report: AttemptReport,
  repoRoot: string,
  source: FlowSource,
): Promise<void> {
  const attempt = report.test.currentAttempt!;
  const index = attempt.stepCount + 1;
  const id = `${attempt.id}:step:${index}`;
  const privacy = report.privacy;
  const sensitive =
    safeUrl(action.beforeVersion.route, privacy).sensitive ||
    safeUrl(page.url, privacy).sensitive;
  const capture = async (suffix: string): Promise<ResultFrame> => {
    if (sensitive) return { status: "omitted", reason: "sensitive_page" };
    if (!page.captureFrame)
      return { status: "unavailable", reason: "capture_unavailable" };
    try {
      const before = await pageVersion(page);
      if (safeUrl(before.route, privacy).sensitive)
        return { status: "omitted", reason: "sensitive_page" };
      const bytes = await page.captureFrame();
      const after = await pageVersion(page);
      if (
        before.document !== after.document ||
        before.revision !== after.revision ||
        before.route !== after.route
      )
        return { status: "unavailable", reason: "stale_frame" };
      return await report.saveFrame(attempt, `${id}:${suffix}`, bytes);
    } catch {
      return { status: "unavailable", reason: "capture_failed" };
    }
  };
  const failed = action.status === "failed";
  await report.test.addStep({
    id,
    index,
    kind: "action",
    operation: action.operation,
    phase: "steps",
    sentence: safeText(action.sentence, privacy, 512),
    detail: failed
      ? `Goal action failed: ${action.reason}.`
      : "Goal action; replay shows the resulting page.",
    sourceStack: [safeSource(source, repoRoot, privacy)],
    state: "completed",
    verdict: action.status,
    flags: [],
    elapsedMs: action.elapsedMs,
    page: sensitive
      ? { status: "omitted", reason: "sensitive_page" }
      : await reportPage(page, `${id}:observation:1`, privacy),
    locator: {
      confidence: action.confidence,
      source: "model",
      cache: null,
      options: sensitive
        ? []
        : [
            {
              label: safeText(action.targetName, privacy, 120),
              role: safeText(action.targetRole, privacy, 80),
              probability: action.probability,
            },
          ],
    },
    judgement: null,
    observations: [],
    calls: action.calls.map((call) => resultCall(call, "planner")),
    error: failed
      ? {
          code: action.reason!,
          message: `Goal action did not complete: ${action.reason}.`,
        }
      : null,
    evidence: !failed
      ? { status: "omitted", reason: "clean_step" }
      : !report.evidenceEnabled
        ? { status: "omitted", reason: "disabled" }
        : await capture("evidence"),
    replayFrame: report.replay ? await capture("replay") : null,
    targetBox: null,
  });
}

/** Run one validated attempt with setup, body, and exhaustive teardown. */
export async function runFlow(
  file: string,
  runDependencies: FlowRunnerDependencies,
): Promise<FlowRunResult> {
  const absolute = path.resolve(file);
  const loaded = await loadFlowFile(absolute, {
    repoRoot: runDependencies.repoRoot,
    rejectSymlinks: true,
  });
  const parsed = await resolveFlowModules(loaded, {
    repoRoot: runDependencies.repoRoot,
  });
  if (!parsed.value) return firstDiagnostic(parsed.diagnostics);
  if (parsed.value.goal && !runDependencies.provider.chooseGoal)
    return unsupported(
      absolute,
      parsed.value.goal.source,
      "The configured provider does not support goal planning.",
    );
  let entryUrl: string;
  try {
    entryUrl = resolveEntryUrl(
      parsed.value.url,
      runDependencies.baseUrl,
      runDependencies.urlOverride,
    );
  } catch (error) {
    return {
      status: "could_not_run",
      file: absolute,
      code: "invalid_test",
      source: { file: absolute, line: 1, col: 1 },
      message:
        error instanceof Error
          ? error.message
          : "The test entry URL could not be resolved.",
      fix: "Add an absolute test URL or configure baseUrl in sedum.config.yaml.",
    };
  }
  let dependencies: AttemptDependencies;
  const { report: runReport, ...runBase } = runDependencies;
  if (runReport) {
    const { recorder, slot, ...shared } = runReport;
    // Each attempt redacts with its own copy: secrets one test resolves or
    // remembers never enter a list another concurrently running test mutates.
    const privacy = {
      ...shared.privacy,
      secretValues: [...shared.privacy.secretValues],
    };
    const file = safeSource(
      { file: absolute, line: 1, col: 1 },
      runDependencies.repoRoot,
      privacy,
    ).file;
    const existing = slot
      ? recorder.testAt(slot.ordinal)
      : recorder.latestTest();
    const retrying =
      existing?.file === file && existing.currentAttempt?.running === true;
    const test = retrying
      ? existing
      : await recorder.beginTest({
          id: parsed.value.identity,
          file,
          description: safeText(parsed.value.description ?? "", privacy, 512),
          tags: parsed.value.tags.map((tag) => safeText(tag, privacy, 120)),
          ...(slot ? { ordinal: slot.ordinal } : {}),
          ...(slot?.lane === undefined ? {} : { lane: slot.lane }),
        });
    dependencies = { ...runBase, report: { ...shared, privacy, test } };
  } else dependencies = runBase;
  const classified = await classifyParsedFlow(parsed, {
    mode: "allow-model",
    cache: dependencies.classificationCache,
    provider: dependencies.provider,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  if (dependencies.report && classified.calls.length)
    await dependencies.report.test.addAttemptCalls(
      classified.calls.map((call) => resultCall(call, "classification")),
    );
  if (!classified.value) return firstDiagnostic(classified.diagnostics);
  let data: Record<string, ResolvedDataEntry>;
  try {
    data = { ...resolveData(classified.value.data, dependencies.env) };
  } catch (error) {
    return {
      status: "could_not_run",
      file: absolute,
      code: "invalid_data",
      message:
        error instanceof Error ? error.message : "Could not resolve test data.",
    };
  }
  const opaqueEntries = Object.values(data);
  if (dependencies.report)
    dependencies.report.privacy.secretValues.push(
      ...Object.values(data)
        .filter((entry) => entry.sensitive)
        .map((entry) => entry.value.reveal()),
    );
  if (dependencies.report && classified.value.goal) {
    const { test, privacy } = dependencies.report;
    await test.setGoal({
      text: safeText(classified.value.goal.text, privacy, Infinity),
      verify: safeText(classified.value.goal.verify, privacy, Infinity),
    });
  }
  let session: BrowserSession | undefined;
  let context: Awaited<ReturnType<BrowserSession["newContext"]>> | undefined;
  let page: BrowserPage | undefined;
  try {
    session = await dependencies.browser.launch({
      ...(dependencies.browserKind === undefined
        ? {}
        : { browser: dependencies.browserKind }),
      ...(dependencies.headless === undefined
        ? {}
        : { headless: dependencies.headless }),
      ...(dependencies.slowMoMs === undefined
        ? {}
        : { slowMoMs: dependencies.slowMoMs }),
      ...(dependencies.headedOverlay ? { overlay: true } : {}),
    });
    context = await session.newContext(
      dependencies.viewport === undefined
        ? {}
        : { viewport: dependencies.viewport },
    );
    page = await context.newPage();
    await executeStep(
      page,
      { op: "goto", url: new RuntimeUrl([entryUrl]) },
      dependencies.signal ? { signal: dependencies.signal } : {},
    );
    const activePage = page;
    type Problem = Exclude<FlowRunResult, { status: "passed" }>;
    const runItems = async (
      items: readonly ClassifiedFlowStep[],
      scope: Record<string, ResolvedDataEntry>,
      continueAfterFailure: boolean,
    ): Promise<Problem | null> => {
      let first: Problem | null = null;
      for (const item of items) {
        let problem: Problem | null = null;
        if (item.kind === "sentence") {
          const outcome = await executeSentence(
            activePage,
            item,
            dependencies,
            scope,
            opaqueEntries,
          );
          if (outcome === "failed")
            problem = { status: "failed", file: absolute, source: item.source };
          else if (outcome !== "continue" && outcome.status !== "passed")
            problem = outcome;
        } else {
          if (!item.resolved)
            problem = unsupported(
              absolute,
              item.source,
              "The module graph is incomplete.",
            ) as Problem;
          else {
            let local: Record<string, ResolvedDataEntry> | undefined;
            try {
              local = {
                ...resolveModuleBindings(
                  item.resolved.parameters,
                  item.resolved.bindings,
                  scope,
                  dependencies.env,
                ),
              };
            } catch (error) {
              const bindingError =
                error instanceof ModuleBindingResolutionError ? error : null;
              const message =
                bindingError?.message ??
                "The module binding could not be resolved.";
              await dependencies.report?.test.addProblem({
                origin: "module_binding",
                outcome: bindingError?.outcome ?? "error",
                phase: item.phase,
                sourceStack: item.sourceStack.map((source) =>
                  safeSource(
                    source,
                    dependencies.repoRoot,
                    dependencies.report!.privacy,
                  ),
                ),
                stepId: null,
                error: {
                  code: bindingError?.code ?? "module_binding_error",
                  message: safeText(message, dependencies.report!.privacy, 512),
                },
              });
              problem =
                bindingError?.outcome === "failed"
                  ? { status: "failed", file: absolute, source: item.source }
                  : {
                      status: "could_not_run",
                      file: absolute,
                      code: bindingError?.code ?? "module_binding_error",
                      source: item.source,
                      message,
                    };
            }
            if (local) {
              if (dependencies.report)
                dependencies.report.privacy.secretValues.push(
                  ...Object.values(local)
                    .filter((entry) => entry.sensitive)
                    .map((entry) => entry.value.reveal()),
                );
              opaqueEntries.push(...Object.values(local));
              problem = await runItems(
                item.resolved.steps,
                local,
                continueAfterFailure,
              );
            }
          }
        }
        if (problem) {
          first ??= problem;
          if (!continueAfterFailure) return first;
        }
      }
      return first;
    };
    const setupProblem = await runItems(classified.value.before, data, false);
    let bodyProblem: Problem | null = null;
    const goal = classified.value.goal;
    if (!setupProblem && goal) {
      const purposes: ResultCall["purpose"][] = [];
      let reportedCalls = 0;
      const goalResult = await runGoal(
        activePage,
        {
          chooseGoal: (state, options) => {
            purposes.push("planner");
            return dependencies.provider.chooseGoal!(state, options);
          },
        },
        {
          holds: (text, digest, options) => {
            purposes.push("judge");
            return dependencies.provider.holds(text, digest, options);
          },
        },
        {
          goal: goal.text,
          verify: [
            goal.verify.replace(
              /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
              (placeholder, key: string) =>
                data[key]?.modelVisible
                  ? data[key].value.reveal()
                  : placeholder,
            ),
          ],
          data,
          ...(dependencies.report
            ? {
                onAction: async (action: GoalAction) => {
                  await recordGoalAction(
                    activePage,
                    action,
                    dependencies.report!,
                    dependencies.repoRoot,
                    goal.source,
                  );
                  reportedCalls += action.calls.length;
                },
              }
            : {}),
          ...(dependencies.verifyPolicy
            ? { verifyPolicy: dependencies.verifyPolicy }
            : {}),
          ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        },
      );
      const goalSource =
        goalResult.reason === "verification_failed"
          ? goal.verifySource
          : goal.source;
      if (dependencies.report) {
        const { test, privacy } = dependencies.report;
        const attempt = test.currentAttempt!;
        const checked = goalResult.verification[0];
        await test.addStep({
          id: `${attempt.id}:step:${attempt.stepCount + 1}`,
          index: attempt.stepCount + 1,
          kind: "verify",
          operation: "goal",
          phase: "steps",
          sentence: safeText(goal.text, privacy, 512),
          detail: safeText(
            `${goalResult.actions} actions, ${goalResult.requests} requests; ${goalResult.reason}. Verify: ${goal.verify}`,
            privacy,
            512,
          ),
          sourceStack: [goalSource].map((source) =>
            safeSource(source, dependencies.repoRoot, privacy),
          ),
          state: "completed",
          verdict: goalResult.status,
          flags:
            checked?.flags.filter(
              (flag): flag is "low_confidence" | "contradiction" =>
                flag === "low_confidence" || flag === "contradiction",
            ) ?? [],
          elapsedMs: goalResult.elapsedMs,
          page: { status: "omitted", reason: "goal_summary" },
          locator: null,
          judgement: checked
            ? {
                holds: checked.holds,
                contradicted: checked.contradicted,
                threshold: dependencies.verifyPolicy?.minP ?? DEFAULT_MIN_P,
                band: dependencies.verifyPolicy?.band ?? DEFAULT_BAND,
                contradictionCutoff:
                  dependencies.verifyPolicy?.contradictionCutoff ??
                  DEFAULT_CONTRADICTION_CUTOFF,
                judgedExcerpt: null,
              }
            : null,
          observations: [],
          calls: goalResult.calls
            .slice(reportedCalls)
            .map((call, index) =>
              resultCall(call, purposes[index + reportedCalls] ?? "planner"),
            ),
          error:
            goalResult.status === "failed"
              ? {
                  code: goalResult.reason,
                  message: `Goal did not pass: ${goalResult.reason}.`,
                }
              : null,
          evidence: { status: "omitted", reason: "goal_summary" },
          replayFrame: null,
          targetBox: null,
        });
      }
      if (goalResult.status === "failed")
        bodyProblem = {
          status: "failed",
          file: absolute,
          source: goalSource,
          retryable: false,
        };
    } else if (!setupProblem) {
      bodyProblem = await runItems(classified.value.steps, data, false);
    }
    const teardownProblem = activePage.closed
      ? null
      : await runItems(classified.value.after, data, true);
    const primary = setupProblem ?? bodyProblem ?? teardownProblem;
    if (!primary) {
      await dependencies.report?.test.finishTest("passed");
      return { status: "passed", file: absolute };
    }
    if (primary.status === "failed")
      await dependencies.report?.test.finishTest("failed");
    return goal && primary.status === "failed"
      ? { ...primary, retryable: false }
      : primary;
  } catch (error) {
    return runtimeFailure(absolute, error);
  } finally {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(session);
  }
}
