/** A browser action requested by a Sedum flow. */
export interface ActionRequest {
  readonly description: string;
}

export * from "./run-result.js";
export * from "./run-recorder.js";
export * from "./report-privacy.js";

export * from "./browser-driver.js";
export * from "./reusable-browser.js";
export * from "./page-protocol.js";
export * from "./page-bridge.js";
export * from "./page-cache.js";
export * from "./cache-store.js";
export * from "./step-executor.js";
export * from "./provider.js";
export * from "./provider-gate.js";
export * from "./vision.js";
export * from "./locator.js";
export * from "./flow-types.js";
export * from "./flow-values.js";
export * from "./flow-loader.js";
export * from "./flow-modules.js";
export * from "./classification.js";
export * from "./classification-cache.js";
export * from "./flow-classification.js";
export * from "./project-discovery.js";
export * from "./project-validation.js";
export * from "./project-listing.js";
export * from "./flow-runner.js";
export * from "./assertion-engine.js";
export {
  goalOperations,
  goalChoiceAccepted,
  runGoal,
  type GoalState,
  type GoalValueState,
  type GoalChoice,
  type GoalDecision,
  type GoalPlanner,
  type GoalOptions,
  type GoalAction,
  type GoalResult,
} from "./goal-runner.js";
export * from "./script-registry.js";
export * from "./script-loader.js";
export * from "./script-sentences.js";
export * from "./script-runner.js";
export * from "./script-rejections.js";
