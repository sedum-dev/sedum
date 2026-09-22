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

/** Future model adapters supply these separate decisions. */
export interface Resolver {
  resolve(description: string): Promise<unknown>;
}

export interface Judge {
  judge(description: string): Promise<unknown>;
}
