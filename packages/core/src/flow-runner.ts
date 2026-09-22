import path from "node:path";
import { AssertionEngineError, verify } from "./assertion-engine.js";
import type { BrowserDriver, BrowserPage } from "./browser-driver.js";
import type {
  ClassificationCache,
  ClassificationProvider,
} from "./classification.js";
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
import { resolveTarget } from "./locator.js";
import { quietPage } from "./page-bridge.js";
import type { Judge, Resolver } from "./provider.js";
import { RuntimeUrl, type StepCommand, executeStep } from "./step-executor.js";

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
      readonly message: string;
      readonly source?: FlowSource;
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
  readonly signal?: AbortSignal;
}

function firstDiagnostic(
  diagnostics: readonly FlowDiagnostic[],
): FlowRunResult {
  const diagnostic = diagnostics.find((item) => item.severity === "error");
  return {
    status: "could_not_run",
    file: diagnostic?.source.file ?? "",
    message: diagnostic?.message ?? "The test file could not be validated.",
    ...(diagnostic ? { source: diagnostic.source } : {}),
  };
}

function unsupported(
  file: string,
  source: FlowSource,
  message: string,
): FlowRunResult {
  return { status: "could_not_run", file, source, message };
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
  // Observe one settled DOM before locating/judging the next step. This avoids
  // treating the mutation from the previous action as a fresh locator target;
  // it does not retry or replay an action.
  const quiet = await quietPage(page, 80, 4_000).catch(() => ({
    quiet: false,
  }));
  if (!quiet.quiet)
    return unsupported(
      step.source.file,
      step.source,
      "The page did not settle before this step could be resolved.",
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
      return result.verdict === "failed" ? "failed" : "continue";
    } catch (error) {
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
            return result.verdict === "failed" ? "failed" : "continue";
          } catch (retryError) {
            return unsupported(
              step.source.file,
              step.source,
              retryError instanceof Error
                ? retryError.message
                : "The assertion could not be judged.",
            );
          }
        }
      }
      return unsupported(
        step.source.file,
        step.source,
        error instanceof Error
          ? error.message
          : "The assertion could not be judged.",
      );
    }
  }
  if (step.op !== "click" && step.op !== "type")
    return unsupported(
      step.source.file,
      step.source,
      `The ${step.op} operation is not part of this walking skeleton.`,
    );
  const locate = () =>
    resolveTarget(page, dependencies.provider, {
      operation: step.op === "type" ? "fill" : "click",
      sentence: step.text,
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
    });
  let resolved = await locate();
  // A resolver response can arrive during an unrelated DOM revision. One fresh
  // read is safe: it does not reuse a target or replay the preceding action.
  if (resolved.kind === "unresolved" && resolved.reason === "stale") {
    const settled = await quietPage(page, 80, 4_000).catch(() => ({
      quiet: false,
    }));
    if (settled.quiet) resolved = await locate();
  }
  if (resolved.kind !== "resolved")
    return unsupported(
      step.source.file,
      step.source,
      `Could not resolve this ${step.op} step (${resolved.reason}).`,
    );
  let command: StepCommand;
  if (step.op === "click") command = { op: "click", target: resolved.target };
  else {
    const operand = validateTypeOperand(step);
    if ("diagnostic" in operand) return firstDiagnostic([operand.diagnostic]);
    command = {
      op: "type",
      target: resolved.target,
      value: resolveTypeOperand(operand.operand, data),
    };
  }
  await executeStep(page, command);
  return "continue";
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
  if (!classified.value) return firstDiagnostic(classified.diagnostics);
  let data: ReturnType<typeof resolveData>;
  try {
    data = resolveData(classified.value.data, dependencies.env);
  } catch (error) {
    return {
      status: "could_not_run",
      file: absolute,
      message:
        error instanceof Error ? error.message : "Could not resolve test data.",
    };
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
      await executeStep(page, {
        op: "goto",
        url: new RuntimeUrl([classified.value.url]),
      });
    for (const item of classified.value.steps) {
      if (item.kind !== "sentence")
        return unsupported(
          absolute,
          item.source,
          "Modules are not supported by this walking skeleton.",
        );
      const outcome = await executeSentence(page, item, dependencies, data);
      if (outcome === "failed")
        return { status: "failed", file: absolute, source: item.source };
      if (outcome !== "continue") return outcome;
    }
    return { status: "passed", file: absolute };
  } catch (error) {
    return {
      status: "could_not_run",
      file: absolute,
      message:
        error instanceof Error ? error.message : "The browser run failed.",
    };
  } finally {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(session);
  }
}
