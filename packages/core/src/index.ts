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
export * from "./snapshot-observation.js";
export * from "./observation-cache.js";
export type { ObservedClickResult } from "./playwright-observer.js";

/** Future model adapters supply these separate decisions. */
export interface Resolver {
  resolve(description: string): Promise<unknown>;
}

export interface Judge {
  judge(description: string): Promise<unknown>;
}
