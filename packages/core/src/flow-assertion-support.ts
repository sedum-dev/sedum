import { AssertionEngineError } from "./assertion-engine.js";
import type { BrowserPage } from "./browser-driver.js";
import type { ClassifiedFlowSentence } from "./flow-classification.js";
import type {
  AttemptDependencies,
  FlowRunResult,
} from "./flow-runner-contracts.js";
import { unsupported } from "./flow-runner-support.js";
import type { ResolvedDataEntry } from "./flow-values.js";
import type { LocatorResult } from "./locator.js";
import { pageVersion } from "./page-bridge.js";
import type { PageVersion } from "./page-protocol.js";
import type { ProviderError } from "./provider.js";
import type { ResultCall } from "./run-result.js";
import type { MeasureResult, VerifyResult } from "./assertion-engine.js";

export type ExecutionOutcome = "continue" | "failed" | FlowRunResult;

export interface AssertionFacts {
  readonly verify?: VerifyResult | MeasureResult;
  readonly locator?: LocatorResult;
  readonly error?: { readonly code: string; readonly message: string };
  readonly failedCalls?: readonly ResultCall[];
}

export interface SentenceAssertionContext {
  readonly page: BrowserPage;
  readonly step: ClassifiedFlowSentence;
  readonly dependencies: AttemptDependencies;
  readonly data: Record<string, ResolvedDataEntry>;
  readonly opaqueEntries: readonly ResolvedDataEntry[];
  readonly check: boolean;
  readonly record: (
    outcome: ExecutionOutcome,
    facts?: AssertionFacts,
  ) => Promise<ExecutionOutcome>;
  readonly runWide: (
    error: ProviderError,
    facts?: Pick<AssertionFacts, "failedCalls">,
  ) => Promise<ProviderError>;
  readonly reobserve: (
    first: LocatorResult,
    locate: () => Promise<LocatorResult>,
  ) => Promise<LocatorResult>;
}

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 200));

function pageChanged(before: PageVersion | null, now: PageVersion | null) {
  if (!before || !now) return true;
  if (before.revision !== now.revision) return true;
  if (before.document !== now.document) return true;
  return before.route !== now.route;
}

export async function waitForPageChange(
  context: SentenceAssertionContext,
  before: PageVersion | null,
  deadline: number,
  stopWhenAborted = true,
) {
  while (performance.now() < deadline) {
    await delay();
    if (stopWhenAborted && context.dependencies.signal?.aborted) return false;
    const now = await readPageVersion(context.page);
    if (pageChanged(before, now)) return true;
  }
  return false;
}

export function readPageVersion(page: BrowserPage) {
  return pageVersion(page).catch(() => null);
}

export function revealValues(
  text: string,
  data: Record<string, ResolvedDataEntry>,
) {
  return text.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
    (placeholder, key: string) => data[key]?.value.reveal() ?? placeholder,
  );
}

export function assertionFailure(
  context: SentenceAssertionContext,
  error: unknown,
  failedCalls: readonly ResultCall[],
) {
  const detail =
    error instanceof Error
      ? error.message
      : "The assertion could not be judged.";
  const code =
    error instanceof AssertionEngineError ? error.code : "assertion_error";
  return context.record(
    unsupported(context.step.source.file, context.step.source, detail),
    {
      failedCalls,
      error: { code, message: "The assertion could not be judged." },
    },
  );
}
