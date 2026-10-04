import type { BrowserPage } from "./browser-driver.js";
import type { FlowSource } from "./flow-types.js";
import type { GoalAction } from "./goal-runner.js";
import { captureStableGoalFrame } from "./goal-reporting-capture.js";
import type { AttemptReport } from "./flow-runner-contracts.js";
import { reportPage, safeSource, safeText, safeUrl } from "./report-privacy.js";
import type { ResultFrame, ResultStep } from "./run-result.js";
import { resultCall } from "./flow-runner-support.js";

export interface GoalActionReportRequest {
  readonly page: BrowserPage;
  readonly action: GoalAction;
  readonly report: AttemptReport;
  readonly repoRoot: string;
  readonly source: FlowSource;
  readonly group?: readonly string[];
  readonly canceled?: boolean;
}

interface ActionProjection {
  readonly id: string;
  readonly index: number;
  readonly sensitive: boolean;
  readonly failed: boolean;
}

function projectAction(request: GoalActionReportRequest): ActionProjection {
  const attempt = request.report.test.currentAttempt!;
  const index = attempt.stepCount + 1;
  return {
    id: `${attempt.id}:step:${index}`,
    index,
    failed: request.action.status === "failed",
    sensitive:
      safeUrl(request.action.beforeVersion.route, request.report.privacy)
        .sensitive ||
      safeUrl(request.page.url, request.report.privacy).sensitive,
  };
}

function projectLocator(
  request: GoalActionReportRequest,
  sensitive: boolean,
): NonNullable<ResultStep["locator"]> {
  const { action, report } = request;
  return {
    confidence: action.confidence,
    source: "model",
    cache: null,
    options: sensitive
      ? []
      : [
          {
            label: safeText(action.targetName, report.privacy, 120),
            role: safeText(action.targetRole, report.privacy, 80),
            probability: action.probability,
          },
        ],
  };
}

function actionFrame(
  request: GoalActionReportRequest,
  projection: ActionProjection,
  suffix: string,
): Promise<ResultFrame> {
  const attempt = request.report.test.currentAttempt!;
  return captureStableGoalFrame({
    page: request.page,
    privacy: request.report.privacy,
    sensitive: projection.sensitive,
    save: (bytes) =>
      request.report.saveFrame(attempt, `${projection.id}:${suffix}`, bytes),
  });
}

const actionDetail = (action: GoalAction): string =>
  action.status === "failed"
    ? `Goal action failed: ${action.reason}.`
    : "Goal action; replay shows the resulting page.";

const actionError = (action: GoalAction): ResultStep["error"] =>
  action.status === "failed"
    ? {
        code: action.reason!,
        message: `Goal action did not complete: ${action.reason}.`,
      }
    : null;

async function actionEvidence(
  request: GoalActionReportRequest,
  projection: ActionProjection,
): Promise<ResultFrame> {
  if (!projection.failed) return { status: "omitted", reason: "clean_step" };
  if (!request.report.evidenceEnabled)
    return { status: "omitted", reason: "disabled" };
  return actionFrame(request, projection, "evidence");
}

const actionGroup = ({ group, report }: GoalActionReportRequest) =>
  group
    ? { group: group.map((name) => safeText(name, report.privacy, 120)) }
    : {};

/** Record a goal action from a structured request. */
export async function recordGoalActionRequest(
  request: GoalActionReportRequest,
): Promise<void> {
  const { action, report } = request;
  const projected = projectAction(request);
  await report.test.addStep({
    id: projected.id,
    index: projected.index,
    kind: "action",
    operation: action.operation,
    phase: "steps",
    sentence: safeText(action.sentence, report.privacy, 512),
    detail: actionDetail(action),
    ...actionGroup(request),
    sourceStack: [safeSource(request.source, request.repoRoot, report.privacy)],
    state: request.canceled ? "error" : "completed",
    verdict: request.canceled ? null : action.status,
    flags: [],
    elapsedMs: action.elapsedMs,
    page: projected.sensitive
      ? { status: "omitted", reason: "sensitive_page" }
      : await reportPage(
          request.page,
          `${projected.id}:observation:1`,
          report.privacy,
        ),
    locator: projectLocator(request, projected.sensitive),
    judgement: null,
    observations: [],
    calls: action.calls.map((call) => resultCall(call, "planner")),
    error: actionError(action),
    evidence: await actionEvidence(request, projected),
    replayFrame: report.replay
      ? await actionFrame(request, projected, "replay")
      : null,
    targetBox: null,
  });
}
