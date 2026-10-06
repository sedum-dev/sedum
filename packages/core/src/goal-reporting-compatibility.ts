import type { BrowserPage } from "./browser-driver.js";
import type { AttemptReport } from "./flow-runner/contracts.js";
import type { FlowSource } from "./flow-types.js";
import type { GoalAction } from "./goal-runner.js";
import { recordGoalActionRequest } from "./goal-action-reporting.js";

type RecordGoalActionArguments = readonly [
  page: BrowserPage,
  action: GoalAction,
  report: AttemptReport,
  repoRoot: string,
  source: FlowSource,
  group?: readonly string[],
  canceled?: boolean,
];

/** Preserve the positional API used by script-runner and existing consumers. */
export function recordGoalAction(
  ...[
    page,
    action,
    report,
    repoRoot,
    source,
    group,
    canceled = false,
  ]: RecordGoalActionArguments
): Promise<void> {
  return recordGoalActionRequest({
    page,
    action,
    report,
    repoRoot,
    source,
    ...(group ? { group } : {}),
    canceled,
  });
}
