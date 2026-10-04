import {
  DEFAULT_PROVIDER_CONCURRENCY,
  FileClassificationCache,
  OpenRouterVisionResolver,
  PlaywrightBrowserDriver,
  ProviderGate,
  ReusableBrowserDriver,
  isScriptTestFile,
  probeOpenRouterKey,
  runFlow,
  runScriptTest,
  type FlowRunnerDependencies,
  type RejectionRouter,
  type RunRecorder,
  type VisionKeyProbe,
} from "@sedum-dev/core";
import { availableParallelism } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  canonicalDiagnosticError,
  flowDiagnostic,
  stopsRun,
} from "./diagnostics.js";
import type { ResolvedProjectConfig } from "./config.js";
import { openLocatorCache } from "./locator-cache-store.js";
import { createCliProvider } from "./provider-factory.js";
import { ProgressWriter } from "./progress-writer.js";
import type { RunCommandOptions } from "./run-command.js";
import { ReporterOutputError } from "./run-command-output.js";
import { planLanes, runPool } from "./run-pool.js";
import { verifyGraceMs } from "./run-command-support.js";
import type { CliDiagnostic } from "./diagnostics.js";

interface SelectedTest {
  readonly file: string;
  readonly id: string;
}

interface TestExecutionRequest {
  readonly config: ResolvedProjectConfig;
  readonly options: RunCommandOptions;
  readonly files: readonly SelectedTest[];
  readonly globalSelectedTests: number;
  readonly discoveryProblems: NonNullable<
    import("@sedum-dev/core").RunResult["discoveryProblems"]
  >;
  readonly signal: AbortSignal;
  readonly recorder: RunRecorder;
  readonly writer: ProgressWriter;
  readonly rejections: RejectionRouter;
  readonly reporterFailed: () => boolean;
}

interface MutableOutcome {
  operational: CliDiagnostic | null;
  erroredTests: number;
}

interface ExecutionSlot {
  readonly browser: ReusableBrowserDriver;
  readonly test: SelectedTest;
  readonly lane: number;
  readonly ordinal: number;
}

interface ExecutionResources {
  readonly provider: Awaited<ReturnType<typeof createCliProvider>>;
  readonly classificationCache: Awaited<
    ReturnType<typeof FileClassificationCache.load>
  >;
  readonly locatorCache: Awaited<ReturnType<typeof openLocatorCache>>;
  readonly visionResolver?: OpenRouterVisionResolver;
}

export interface TestExecutionOutcome {
  readonly operational: CliDiagnostic | null;
  readonly erroredTests: number;
}

export async function executeSelectedTests(
  request: TestExecutionRequest,
): Promise<TestExecutionOutcome> {
  const lanes = planLanes(
    request.options.parallel ?? 1,
    request.options.availableParallelism ?? availableParallelism(),
    request.files.length,
  );
  const providerConcurrency =
    request.options.providerConcurrency ??
    Math.min(DEFAULT_PROVIDER_CONCURRENCY, lanes * 2);
  const visionKey = await probeVision(request.config, request.options);
  await selectTests(request, lanes, providerConcurrency, visionKey);
  if (request.signal.aborted) throw new Error("canceled");

  const gate = new ProviderGate({ concurrency: providerConcurrency });
  const resources = await createExecutionResources(request, gate);
  const driver = new PlaywrightBrowserDriver();
  const browsers = Array.from(
    { length: lanes },
    () => new ReusableBrowserDriver(driver),
  );
  const outcome: MutableOutcome = { operational: null, erroredTests: 0 };
  try {
    await runPool({
      items: request.files,
      lanes,
      signal: request.signal,
      run: (test, lane, ordinal) =>
        runSelectedTest(
          request,
          resources,
          { browser: browsers[lane]!, test, lane, ordinal },
          outcome,
        ),
    });
  } finally {
    gate.close();
    await Promise.all(browsers.map((browser) => browser.recycle()));
  }
  return outcome;
}

async function probeVision(
  config: ResolvedProjectConfig,
  options: RunCommandOptions,
): Promise<VisionKeyProbe | null> {
  if (!config.vision.enabled) return null;
  return (options.probeVisionKey ?? probeOpenRouterKey)(
    config.visionApiKey!,
  ).catch((): VisionKeyProbe => "unreachable");
}

async function selectTests(
  request: TestExecutionRequest,
  lanes: number,
  providerConcurrency: number,
  visionKey: VisionKeyProbe | null,
): Promise<void> {
  await request.recorder.selectTests(request.files.length, {
    parallel: { requested: request.options.parallel ?? 1, lanes },
    shard: request.options.shard
      ? {
          ...request.options.shard,
          globalSelectedTests: request.globalSelectedTests,
        }
      : null,
    providerConcurrency,
    ...(visionKey
      ? { vision: { model: request.config.vision.model, key: visionKey } }
      : {}),
  });
  if (request.discoveryProblems.length)
    await request.recorder.addDiscoveryProblems(request.discoveryProblems);
}

async function createExecutionResources(
  request: TestExecutionRequest,
  gate: ProviderGate,
): Promise<ExecutionResources> {
  const { config, options } = request;
  return {
    provider: await createCliProvider(config, { gate }),
    classificationCache: await FileClassificationCache.load(
      path.join(config.projectRoot, ".sedum", "classifications.json"),
      config.providerModel,
      config.providerName,
    ),
    locatorCache: await openLocatorCache(config.projectRoot, {
      disabled: options.locatorCacheDisabled ?? false,
      ciOptIn: options.locatorCacheCi ?? false,
      env: process.env,
    }),
    ...(config.vision.enabled
      ? {
          visionResolver: new OpenRouterVisionResolver({
            apiKey: config.visionApiKey!,
            model: config.vision.model,
            timeoutMs: config.vision.timeoutMs,
          }),
        }
      : {}),
  };
}

async function runSelectedTest(
  request: TestExecutionRequest,
  resources: ExecutionResources,
  slot: ExecutionSlot,
  outcome: MutableOutcome,
): Promise<"continue" | "stop"> {
  for (let attempt = 0; attempt <= (request.options.retries ?? 0); attempt++) {
    await startRetryAttempt(request, slot, attempt);
    const result = await executeTest(request, resources, slot);
    const directive = await attemptDirective(request, slot, result, outcome);
    if (directive === "stop") return "stop";
    if (directive === "complete") break;
  }
  return "continue";
}

async function startRetryAttempt(
  request: TestExecutionRequest,
  slot: ExecutionSlot,
  attempt: number,
): Promise<void> {
  if (attempt === 0) return;
  await request.recorder.testAt(slot.ordinal)?.startAttempt(slot.lane);
}

async function attemptDirective(
  request: TestExecutionRequest,
  slot: ExecutionSlot,
  result: Awaited<ReturnType<typeof runFlow>>,
  outcome: MutableOutcome,
): Promise<"retry" | "complete" | "stop"> {
  if (request.reporterFailed()) throw new ReporterOutputError();
  if (request.signal.aborted) return "stop";
  if (result.status === "could_not_run")
    return handleOperationalFailure(request, slot, result, outcome);
  if (result.status === "passed") return "complete";
  return result.retryable === false ? "complete" : "retry";
}

async function executeTest(
  request: TestExecutionRequest,
  resources: ExecutionResources,
  slot: ExecutionSlot,
) {
  const dependencies = testDependencies(request, resources, slot);
  return isScriptTestFile(slot.test.file)
    ? runScriptTest(slot.test.file, slot.test.id, dependencies)
    : runFlow(slot.test.file, dependencies);
}

function testDependencies(
  request: TestExecutionRequest,
  resources: ExecutionResources,
  slot: ExecutionSlot,
): FlowRunnerDependencies {
  const { config, options } = request;
  const { browser, lane, ordinal } = slot;
  return {
    repoRoot: config.projectRoot,
    browser,
    provider: resources.provider,
    classificationCache: resources.classificationCache,
    locatorCache: resources.locatorCache,
    ...(resources.visionResolver
      ? { visionResolver: resources.visionResolver }
      : {}),
    env: {
      ...config.variables,
      SEDUM_PARALLEL_INDEX: String(lane),
      SEDUM_SHARD_INDEX: String(options.shard?.index ?? 1),
      SEDUM_ATTEMPT_KEY: randomBytes(6).toString("hex"),
    },
    browserKind: config.browser,
    viewport: config.viewport,
    verifyPolicy: config.thresholds,
    verifyGraceMs: verifyGraceMs(process.env.SEDUM_VERIFY_GRACE_MS),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(options.urlOverride ? { urlOverride: options.urlOverride } : {}),
    ...(options.headed ? { headless: false, headedOverlay: true } : {}),
    ...(options.slowMoMs !== undefined ? { slowMoMs: options.slowMoMs } : {}),
    signal: request.signal,
    rejections: request.rejections,
    report: {
      recorder: request.recorder,
      slot: { ordinal, lane },
      privacy: {
        secretValues: [],
        sensitiveOrigins: options.sensitiveOrigins,
      },
      evidenceEnabled: options.evidence,
      replay: options.replay,
      saveFrame: (attempt, frameId, bytes) =>
        request.writer.saveFrame(attempt, frameId, bytes),
    },
  };
}

async function handleOperationalFailure(
  request: TestExecutionRequest,
  slot: ExecutionSlot,
  result: Extract<
    Awaited<ReturnType<typeof runFlow>>,
    { status: "could_not_run" }
  >,
  outcome: MutableOutcome,
): Promise<"complete" | "stop"> {
  await slot.browser.recycle();
  const diagnostic = flowDiagnostic(result, request.config.providerName);
  outcome.operational ??= diagnostic;
  if (stopsRun(result.code)) return "stop";
  outcome.erroredTests += 1;
  await request.recorder
    .testAt(slot.ordinal)
    ?.errorTest(canonicalDiagnosticError(diagnostic));
  return "complete";
}
