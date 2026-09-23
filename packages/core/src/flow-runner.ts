import path from "node:path";
import {
  AssertionEngineError,
  verify,
  type VerifyPolicy,
  type VerifyResult,
} from "./assertion-engine.js";
import {
  BrowserDriverError,
  type BrowserDriver,
  type BrowserKind,
  type BrowserPage,
} from "./browser-driver.js";
import type {
  ClassificationCache,
  ClassificationProvider,
} from "./classification.js";
import {
  classifyParsedFlow,
  type ClassifiedFlowSentence,
  type ClassifiedFlowStep,
} from "./flow-classification.js";
import { loadFlowFile } from "./flow-loader.js";
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
import { pageVersion, quietPage, readTarget } from "./page-bridge.js";
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
  RuntimeValue,
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
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Temporary debug switch; the final CLI/config surface owns launch policy. */
  readonly headless?: boolean;
  readonly browserKind?: BrowserKind;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly verifyPolicy?: VerifyPolicy;
  readonly baseUrl?: string;
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

function claim(
  step: ClassifiedFlowSentence,
  data: Readonly<Record<string, ResolvedDataEntry>>,
): string {
  return step.text
    .replace(
      /^\s*(?:verify|assert|check|confirm|ensure|expect)\b\s*(?:that\s+)?/iu,
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
export function resolveEntryUrl(testUrl?: string, baseUrl?: string): string {
  if (testUrl) {
    try {
      return baseUrl ? new URL(testUrl, baseUrl).href : new URL(testUrl).href;
    } catch {
      throw new Error(
        baseUrl
          ? "The test URL is invalid relative to the configured baseUrl."
          : "The test URL is relative but no baseUrl is configured.",
      );
    }
  }
  if (baseUrl) return new URL(baseUrl).href;
  throw new Error("The test has no URL and no baseUrl is configured.");
}

async function closeQuietly(resource: { close(): Promise<void> } | undefined) {
  await resource?.close().catch(() => undefined);
}

async function executeSentence(
  page: BrowserPage,
  step: ClassifiedFlowSentence,
  dependencies: FlowRunnerDependencies,
  data: Record<string, ResolvedDataEntry>,
  opaqueEntries: ResolvedDataEntry[],
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
            source: locator.calls.length ? "model" : "none",
            options: (sensitive
              ? []
              : locator.diagnostic.topOptions.slice(0, 5)
            ).map((option) => ({
              label: safeText(option.name, privacy, 120),
              role: safeText(option.role, privacy, 80),
              probability: option.probability,
            })),
            cache: null,
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
        locator = await resolveTarget(page, dependencies.provider, {
          operation: "read",
          sentence: match[1]!,
          projectText: (text) => redactOpaqueText(text, opaqueEntries),
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
    } catch {
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
  if (step.op === "verify") {
    const judge = () =>
      verify(page, dependencies.provider, claim(step, data), {
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        projectText: (text) => redactOpaqueText(text, opaqueEntries),
        ...(dependencies.verifyPolicy ?? {}),
      });
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
  const locate = () =>
    resolveTarget(page, dependencies.provider, {
      operation: step.op === "type" ? "fill" : "click",
      sentence: step.text,
      projectText: (text) => redactOpaqueText(text, opaqueEntries),
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
      try {
        const retried = await locate();
        resolved = { ...retried, calls: [...priorCalls, ...retried.calls] };
      } catch {
        return record(
          unsupported(
            step.source.file,
            step.source,
            "The target could not be resolved.",
          ),
          {
            failedCalls: priorCalls.map((call) => resultCall(call, "locator")),
            error: {
              code: "locator_error",
              message: "The target could not be resolved.",
            },
          },
        );
      }
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
    command = {
      op: "type",
      target: resolved.target,
      value: typeValue!,
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
    return record("continue", {
      locator: resolved,
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

/** Run one validated attempt with setup, body, and exhaustive teardown. */
export async function runFlow(
  file: string,
  dependencies: FlowRunnerDependencies,
): Promise<FlowRunResult> {
  const absolute = path.resolve(file);
  const loaded = await loadFlowFile(absolute, {
    repoRoot: dependencies.repoRoot,
  });
  const parsed = await resolveFlowModules(loaded, {
    repoRoot: dependencies.repoRoot,
  });
  if (!parsed.value) return firstDiagnostic(parsed.diagnostics);
  let entryUrl: string;
  try {
    entryUrl = resolveEntryUrl(parsed.value.url, dependencies.baseUrl);
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
      ...(dependencies.browserKind === undefined
        ? {}
        : { browser: dependencies.browserKind }),
      ...(dependencies.headless === undefined
        ? {}
        : { headless: dependencies.headless }),
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
              await dependencies.report?.recorder.addProblem({
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
    const bodyProblem = setupProblem
      ? null
      : await runItems(classified.value.steps, data, false);
    const teardownProblem = activePage.closed
      ? null
      : await runItems(classified.value.after, data, true);
    const primary = setupProblem ?? bodyProblem ?? teardownProblem;
    if (!primary) {
      await dependencies.report?.recorder.finishTest("passed");
      return { status: "passed", file: absolute };
    }
    if (primary.status === "failed")
      await dependencies.report?.recorder.finishTest("failed");
    return primary;
  } catch (error) {
    return runtimeFailure(absolute, error);
  } finally {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(session);
  }
}
