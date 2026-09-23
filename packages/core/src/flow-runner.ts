import path from "node:path";
import {
  AssertionEngineError,
  verify,
  type VerifyResult,
} from "./assertion-engine.js";
import {
  BrowserDriverError,
  type BrowserDriver,
  type BrowserPage,
} from "./browser-driver.js";
import type {
  ClassificationCache,
  ClassificationProvider,
} from "./classification.js";
import type { CacheStore } from "./cache-store.js";
import {
  classifyParsedFlow,
  type ClassifiedFlowSentence,
} from "./flow-classification.js";
import { loadFlowFile } from "./flow-loader.js";
import {
  resolveData,
  resolveTypeOperand,
  validateTypeOperand,
} from "./flow-values.js";
import type { FlowDiagnostic, FlowSource } from "./flow-types.js";
import { resolveTarget, type LocatorResult } from "./locator.js";
import { stageEntry } from "./page-cache.js";
import { pageVersion, quietPage } from "./page-bridge.js";
import type { PageVersion } from "./page-protocol.js";
import {
  ProviderError,
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
import type { RunRecorder } from "./run-recorder.js";
import {
  RuntimeUrl,
  StepExecutionError,
  type StepCommand,
  executeStep,
} from "./step-executor.js";

export type FlowRunResult =
  | { readonly status: "passed"; readonly file: string }
  | {
      readonly status: "failed";
      readonly file: string;
      readonly source: FlowSource;
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
  readonly browser: BrowserDriver;
  readonly provider: ClassificationProvider & Resolver & Judge;
  readonly classificationCache: ClassificationCache;
  readonly locatorCache?: CacheStore;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Temporary debug switch; the final CLI/config surface owns launch policy. */
  readonly headless?: boolean;
  readonly signal?: AbortSignal;
  readonly report?: {
    readonly recorder: RunRecorder;
    readonly privacy: ReportPrivacy;
    readonly evidenceEnabled: boolean;
    readonly replay: boolean;
    readonly saveFrame: (
      stepId: string,
      bytes: Uint8Array,
    ) => Promise<ResultFrame>;
  };
}

function resultCall(
  call: ProviderCall,
  purpose: ResultCall["purpose"],
  apiMs: number | null = null,
): ResultCall {
  return {
    purpose,
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
    return {
      status: "could_not_run",
      file,
      code: `provider_${error.code}`,
      message: "The model provider could not complete the run safely.",
      fix:
        error.code === "configuration" || error.code === "authentication"
          ? "Check TYPESAFE_API_KEY and provider access, then rerun the test."
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

function claim(step: ClassifiedFlowSentence): string {
  return step.text
    .replace(
      /^\s*(?:verify|assert|check|confirm|ensure|expect)\b\s*(?:that\s+)?/iu,
      "",
    )
    .trim();
}

async function closeQuietly(resource: { close(): Promise<void> } | undefined) {
  await resource?.close().catch(() => undefined);
}

async function executeSentence(
  page: BrowserPage,
  step: ClassifiedFlowSentence,
  dependencies: FlowRunnerDependencies,
  data: ReturnType<typeof resolveData>,
): Promise<"continue" | "failed" | FlowRunResult> {
  const started = performance.now();
  const report = dependencies.report;
  const stepIndex = report
    ? (report.recorder.snapshot.tests.at(-1)?.attempts.at(-1)?.steps.length ??
        0) + 1
    : 0;
  const attemptId =
    report?.recorder.snapshot.tests.at(-1)?.attempts.at(-1)?.id ?? "";
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
      return await report.saveFrame(`${stepId}:${suffix}`, bytes);
    } catch {
      return { status: "unavailable", reason: "capture_failed" };
    }
  };
  type StepFacts = {
    verify?: VerifyResult;
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
    const flags = facts.verify?.flags ?? [];
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
    const judgement = facts.verify
      ? {
          holds: facts.verify.holds,
          contradicted: facts.verify.contradicted,
          threshold: facts.verify.minP,
          band: facts.verify.band,
          contradictionCutoff: facts.verify.contradictionCutoff,
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
    await report.recorder.addStep(result);
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
  if (step.op === "verify") {
    const judge = () =>
      verify(
        page,
        dependencies.provider,
        claim(step),
        dependencies.signal ? { signal: dependencies.signal } : {},
      );
    try {
      const result = await judge();
      // The Judge is read-only. If its evidence went stale during the provider
      // request, take exactly one fresh settled observation rather than
      // reporting a verdict about an old page.
      return record(result.verdict === "failed" ? "failed" : "continue", {
        verify: result,
      });
    } catch (error) {
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
            return record(result.verdict === "failed" ? "failed" : "continue", {
              verify: result,
              failedCalls: priorCalls,
            });
          } catch (retryError) {
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
  if (step.op !== "click" && step.op !== "type")
    return record(
      unsupported(
        step.source.file,
        step.source,
        `The ${step.op} operation is not part of this walking skeleton.`,
      ),
      {
        error: {
          code: "unsupported_operation",
          message: `The ${step.op} operation is not supported.`,
        },
      },
    );
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
  const locate = () =>
    resolveTarget(page, dependencies.provider, {
      operation: step.op === "type" ? "fill" : "click",
      sentence: step.text,
      cacheSentence,
      runtimeDependent,
      ...(dependencies.locatorCache
        ? { cache: dependencies.locatorCache }
        : {}),
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
  let resolved: LocatorResult;
  try {
    resolved = await locate();
  } catch {
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
  // A resolver response can arrive during an unrelated DOM revision. One fresh
  // read is safe: it does not reuse a target or replay the preceding action.
  if (resolved.kind === "unresolved" && resolved.reason === "stale") {
    const priorCalls = resolved.calls;
    const settled = await quietPage(page, 80, 4_000).catch(() => ({
      quiet: false,
    }));
    if (settled.quiet) {
      const retried = await locate();
      resolved = { ...retried, calls: [...priorCalls, ...retried.calls] };
    }
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
          message: `Could not resolve this ${step.op} step.`,
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
  let command: StepCommand;
  if (step.op === "click") command = { op: "click", target: resolved.target };
  else {
    const operand = validateTypeOperand(step);
    if ("diagnostic" in operand)
      return record(firstDiagnostic([operand.diagnostic]), {
        locator: resolved,
        error: {
          code: operand.diagnostic.code,
          message: operand.diagnostic.message,
        },
      });
    command = {
      op: "type",
      target: resolved.target,
      value: resolveTypeOperand(operand.operand, data),
    };
  }
  // An action may navigate or rerender. Preserve metadata from the accepted
  // locator observation before dispatch, rather than borrowing the new page.
  const locatedPage = report
    ? await reportPage(
        page,
        `${stepId}:observation:1`,
        report.privacy,
        resolved.target.driverTarget().version,
      )
    : undefined;
  let replayFrame: ResultFrame | undefined;
  let targetBox: ResultStep["targetBox"] = null;
  try {
    await executeStep(page, command, {
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
            cache: { ...resolved.cache, reason: "storage_error" },
          };
      }
    }
    return record("continue", {
      locator: recordedLocator,
      replayFrame,
      targetBox,
      page: locatedPage,
    });
  } catch (error) {
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

/** Run one plain `steps` flow. Hooks and modules remain owned by SED-29. */
export async function runFlow(
  file: string,
  dependencies: FlowRunnerDependencies,
): Promise<FlowRunResult> {
  const absolute = path.resolve(file);
  const parsed = await loadFlowFile(absolute, {
    repoRoot: dependencies.repoRoot,
  });
  if (!parsed.value) return firstDiagnostic(parsed.diagnostics);
  if (parsed.value.before.length || parsed.value.after.length)
    return unsupported(
      absolute,
      (parsed.value.before[0] ?? parsed.value.after[0])!.source,
      "before/after hooks are not supported by this walking skeleton.",
    );
  if (parsed.value.steps.some((step) => step.kind === "module")) {
    const step = parsed.value.steps.find((item) => item.kind === "module")!;
    return unsupported(
      absolute,
      step.source,
      "Modules are not supported by this walking skeleton.",
    );
  }
  const classified = await classifyParsedFlow(parsed, {
    mode: "allow-model",
    cache: dependencies.classificationCache,
    provider: dependencies.provider,
    ...(dependencies.signal ? { signal: dependencies.signal } : {}),
  });
  if (dependencies.report && classified.calls.length)
    await dependencies.report.recorder.addSetupCalls(
      classified.calls.map((call) => resultCall(call, "classification")),
    );
  if (!classified.value) return firstDiagnostic(classified.diagnostics);
  let data: ReturnType<typeof resolveData>;
  try {
    data = resolveData(classified.value.data, dependencies.env);
  } catch (error) {
    return {
      status: "could_not_run",
      file: absolute,
      code: "invalid_data",
      message:
        error instanceof Error ? error.message : "Could not resolve test data.",
    };
  }
  if (dependencies.report)
    dependencies.report.privacy.secretValues.push(
      ...Object.values(data)
        .filter((entry) => entry.sensitive)
        .map((entry) => entry.value.reveal()),
    );
  if (dependencies.report) {
    const privacy = dependencies.report.privacy;
    const file = safeSource(
      { file: absolute, line: 1, col: 1 },
      dependencies.repoRoot,
      privacy,
    ).file;
    const existing = dependencies.report.recorder.snapshot.tests.at(-1);
    const retrying =
      existing?.file === file &&
      existing.state === "running" &&
      existing.attempts.at(-1)?.state === "running";
    if (!retrying)
      await dependencies.report.recorder.startTest({
        id: `${dependencies.report.recorder.runId}:test:${dependencies.report.recorder.snapshot.tests.length + 1}`,
        file,
        description: safeText(classified.value.description ?? "", privacy, 512),
        tags: classified.value.tags.map((tag) => safeText(tag, privacy, 120)),
      });
  }
  let session: Awaited<ReturnType<BrowserDriver["launch"]>> | undefined;
  let context:
    | Awaited<
        ReturnType<Awaited<ReturnType<BrowserDriver["launch"]>>["newContext"]>
      >
    | undefined;
  let page: BrowserPage | undefined;
  try {
    session = await dependencies.browser.launch({
      ...(dependencies.headless === undefined
        ? {}
        : { headless: dependencies.headless }),
    });
    context = await session.newContext();
    page = await context.newPage();
    if (classified.value.url)
      await executeStep(
        page,
        { op: "goto", url: new RuntimeUrl([classified.value.url]) },
        dependencies.signal ? { signal: dependencies.signal } : {},
      );
    for (const item of classified.value.steps) {
      if (item.kind !== "sentence")
        return unsupported(
          absolute,
          item.source,
          "Modules are not supported by this walking skeleton.",
        );
      const outcome = await executeSentence(page, item, dependencies, data);
      if (outcome === "failed") {
        await dependencies.report?.recorder.finishTest("failed");
        return { status: "failed", file: absolute, source: item.source };
      }
      if (outcome !== "continue") return outcome;
    }
    await dependencies.report?.recorder.finishTest("passed");
    return { status: "passed", file: absolute };
  } catch (error) {
    return runtimeFailure(absolute, error);
  } finally {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(session);
  }
}
