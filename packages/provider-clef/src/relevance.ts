import { buildRelevanceBatches, type RelevanceTest } from "@sedum-dev/core";
import type { ClefRequest } from "./protocol.js";
export type { RelevanceTest } from "@sedum-dev/core";

/** Conservative byte budgets leave room under the hosted request limit. */
export function buildRelevanceRequests(
  diff: string,
  tests: readonly RelevanceTest[],
  model: string,
): { request: ClefRequest; indexes: number[]; chunkIndex: number }[] {
  return buildRelevanceBatches<ClefRequest>(
    diff,
    tests,
    (text, questions) => ({ model, state: { diff: text }, questions }),
    { pair: 28_000, batch: 56_000, questions: 64 },
  );
}
