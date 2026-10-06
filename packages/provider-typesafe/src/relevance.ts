import type { SystemOneRequest } from "@typesafe-ai/sdk";
import { buildRelevanceBatches, type RelevanceTest } from "@sedum-dev/core";
export type { RelevanceTest } from "@sedum-dev/core";

/** Conservative byte budgets leave room within Jev's 32k pair / 64k request token limits. */
export function buildRelevanceRequests(
  diff: string,
  tests: readonly RelevanceTest[],
  model: string,
): { request: SystemOneRequest; indexes: number[]; chunkIndex: number }[] {
  return buildRelevanceBatches<SystemOneRequest>(
    diff,
    tests,
    (text, questions) => ({ model, state: { diff: text }, questions }),
    { pair: 28_000, batch: 56_000, questions: Infinity },
  );
}
