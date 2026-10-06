/** Implementation behind the stable flow-runner public module. */
import { prepareFlowAttempt } from "./attempt-preparation.js";
import { withFlowBrowser } from "./browser-session.js";
import { executeFlowPhases } from "./phase-execution.js";
export type {
  AttemptDependencies,
  AttemptReport,
  FlowRunnerDependencies,
  FlowRunResult,
} from "./contracts.js";
import type { FlowRunnerDependencies, FlowRunResult } from "./contracts.js";
export {
  closeQuietly,
  firstDiagnostic,
  navigationWhy,
  resolveEntryUrl,
  resultCall,
  runtimeFailure,
} from "./support.js";
import { runtimeFailure } from "./support.js";
export {
  executeSentence,
  type SentencePresentation,
} from "./sentence-execution.js";
export { goalFailureArtifacts } from "../goal-failure-reporting.js";
export { recordGoalAction } from "../goal-reporting-compatibility.js";

/** Run one validated attempt with setup, body, and exhaustive teardown. */
export async function runFlow(
  file: string,
  dependencies: FlowRunnerDependencies,
): Promise<FlowRunResult> {
  const prepared = await prepareFlowAttempt(file, dependencies);
  if ("status" in prepared) return prepared;
  try {
    return await withFlowBrowser(prepared, (page) =>
      executeFlowPhases({ ...prepared, page }),
    );
  } catch (error) {
    return runtimeFailure(prepared.absolute, error);
  }
}
