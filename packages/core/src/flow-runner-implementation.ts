/** Implementation behind the stable flow-runner public module. */
import { prepareFlowAttempt } from "./flow-attempt-preparation.js";
import { withFlowBrowser } from "./flow-browser-session.js";
import { executeFlowPhases } from "./flow-phase-execution.js";
export type {
  AttemptDependencies,
  AttemptReport,
  FlowRunnerDependencies,
  FlowRunResult,
} from "./flow-runner-contracts.js";
import type {
  FlowRunnerDependencies,
  FlowRunResult,
} from "./flow-runner-contracts.js";
export {
  closeQuietly,
  firstDiagnostic,
  navigationWhy,
  resolveEntryUrl,
  resultCall,
  runtimeFailure,
} from "./flow-runner-support.js";
import { runtimeFailure } from "./flow-runner-support.js";
export {
  executeSentence,
  type SentencePresentation,
} from "./flow-sentence-execution.js";
export { goalFailureArtifacts } from "./goal-failure-reporting.js";
export { recordGoalAction } from "./goal-reporting-compatibility.js";

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
