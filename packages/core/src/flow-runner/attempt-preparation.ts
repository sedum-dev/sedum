import path from "node:path";
import { classifyParsedFlow } from "../flow-classification.js";
import { loadFlowFile } from "../flow-loader.js";
import { resolveFlowModules } from "../flow-modules.js";
import type { PreparedFlow } from "./orchestration-context.js";
import type {
  AttemptDependencies,
  FlowRunnerDependencies,
  FlowRunResult,
} from "./contracts.js";
import {
  firstDiagnostic,
  resolveEntryUrl,
  resultCall,
  unsupported,
} from "./support.js";
import { resolveData } from "../flow-values.js";
import { safeSource, safeText } from "../report-privacy.js";

type Preparation = PreparedFlow | FlowRunResult;
type FlowIdentity = NonNullable<
  Awaited<ReturnType<typeof resolveFlowModules>>["value"]
>;

function ordinal(slot: { ordinal: number } | undefined) {
  return slot ? { ordinal: slot.ordinal } : {};
}

function lane(slot: { lane?: number } | undefined) {
  return slot?.lane === undefined ? {} : { lane: slot.lane };
}

async function reportTest(
  absolute: string,
  flow: FlowIdentity,
  dependencies: FlowRunnerDependencies,
  report: NonNullable<FlowRunnerDependencies["report"]>,
) {
  const { recorder, slot, ...shared } = report;
  const privacy = {
    ...shared.privacy,
    secretValues: [...shared.privacy.secretValues],
  };
  const file = safeSource(
    { file: absolute, line: 1, col: 1 },
    dependencies.repoRoot,
    privacy,
  ).file;
  const existing = slot ? recorder.testAt(slot.ordinal) : recorder.latestTest();
  const retrying = existing?.file === file && existing.currentAttempt?.running;
  if (retrying) return { ...shared, privacy, test: existing };
  const test = await recorder.beginTest({
    id: flow.identity,
    file,
    description: safeText(flow.description ?? "", privacy, 512),
    tags: flow.tags.map((tag) => safeText(tag, privacy, 120)),
    ...ordinal(slot),
    ...lane(slot),
  });
  return { ...shared, privacy, test };
}

function invalidUrl(absolute: string, error: unknown): FlowRunResult {
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

function entryUrl(
  absolute: string,
  url: string | undefined,
  dependencies: FlowRunnerDependencies,
): string | FlowRunResult {
  try {
    return resolveEntryUrl(url, dependencies.baseUrl, dependencies.urlOverride);
  } catch (error) {
    return invalidUrl(absolute, error);
  }
}

async function attemptDependencies(
  absolute: string,
  flow: FlowIdentity,
  dependencies: FlowRunnerDependencies,
): Promise<AttemptDependencies> {
  const { report, ...base } = dependencies;
  if (!report) return base;
  return {
    ...base,
    report: await reportTest(absolute, flow, dependencies, report),
  };
}

async function prepareDataReport(
  flow: NonNullable<Awaited<ReturnType<typeof classifyParsedFlow>>["value"]>,
  dependencies: AttemptDependencies,
  opaqueEntries: ReturnType<typeof resolveData>[string][],
): Promise<void> {
  const report = dependencies.report;
  if (!report) return;
  report.privacy.secretValues.push(
    ...opaqueEntries
      .filter((item) => item.sensitive)
      .map((item) => item.value.reveal()),
  );
  if (!flow.goal) return;
  await report.test.setGoal({
    text: safeText(flow.goal.text, report.privacy, Infinity),
    verify: safeText(flow.goal.verify, report.privacy, Infinity),
  });
}

async function classifyAndResolveData(
  absolute: string,
  parsed: Awaited<ReturnType<typeof resolveFlowModules>>,
  dependencies: AttemptDependencies,
): Promise<Preparation | Omit<PreparedFlow, "absolute" | "entryUrl">> {
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
  let data;
  try {
    data = { ...resolveData(classified.value.data, dependencies.env) };
  } catch (error) {
    return invalidData(absolute, error);
  }
  const opaqueEntries = Object.values(data);
  await prepareDataReport(classified.value, dependencies, opaqueEntries);
  return { flow: classified.value, dependencies, data, opaqueEntries };
}

function invalidData(absolute: string, error: unknown): FlowRunResult {
  return {
    status: "could_not_run",
    file: absolute,
    code: "invalid_data",
    message:
      error instanceof Error ? error.message : "Could not resolve test data.",
  };
}

/** Load, resolve, classify, and create attempt-scoped report/data state. */
export async function prepareFlowAttempt(
  file: string,
  runDependencies: FlowRunnerDependencies,
): Promise<Preparation> {
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
  const resolvedUrl = entryUrl(absolute, parsed.value.url, runDependencies);
  if (typeof resolvedUrl !== "string") return resolvedUrl;
  const dependencies = await attemptDependencies(
    absolute,
    parsed.value,
    runDependencies,
  );
  const prepared = await classifyAndResolveData(absolute, parsed, dependencies);
  if ("status" in prepared) return prepared;
  return {
    absolute,
    entryUrl: resolvedUrl,
    ...prepared,
  };
}
