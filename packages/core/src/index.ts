/** A browser action requested by a Sedum flow. */
export interface ActionRequest {
  readonly description: string;
}

/** The stable result contract consumed by reporters. */
export interface RunResult {
  readonly status: "passed" | "failed";
  readonly message: string;
}

export * from "./browser-driver.js";
export * from "./page-protocol.js";
export * from "./page-bridge.js";
export * from "./page-cache.js";
export * from "./step-executor.js";
export * from "./provider.js";
export * from "./flow-types.js";
export * from "./flow-values.js";
export * from "./flow-loader.js";
export * from "./classification.js";
export * from "./classification-cache.js";
export * from "./flow-classification.js";
export * from "./assertion-engine.js";
