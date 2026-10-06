import type { BrowserPage } from "../browser-driver.js";
import type { ClassifiedFlowDefinition } from "../flow-classification.js";
import type { AttemptDependencies, FlowRunResult } from "./contracts.js";
import type { ResolvedDataEntry } from "../flow-values.js";

export type FlowProblem = Exclude<FlowRunResult, { status: "passed" }>;

export interface PreparedFlow {
  readonly absolute: string;
  readonly entryUrl: string;
  readonly flow: ClassifiedFlowDefinition;
  readonly dependencies: AttemptDependencies;
  readonly data: Record<string, ResolvedDataEntry>;
  readonly opaqueEntries: ResolvedDataEntry[];
}

export interface ExecutionContext extends PreparedFlow {
  readonly page: BrowserPage;
}
