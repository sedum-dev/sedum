/**
 * Pure scoring for locator eval cases. A case's gold is a list of acceptable
 * `data-eval-gold` ids, "none" (the target is not on the page), or
 * "ambiguous" (a person cannot tell which element is meant). Only the
 * latter two make giving up the correct behavior.
 */

/** Failures that happen before or around the model rather than in its choice. */
const OPERATIONAL = new Set([
  "stale",
  "incomplete",
  "resource_limit",
  "request_too_large",
  "provider_error",
  "timeout",
  "invalid_input",
]);

function argmax(probabilities) {
  let best = null;
  for (const [id, value] of Object.entries(probabilities))
    if (best === null || value > probabilities[best]) best = id;
  return best;
}

function sameProjection(a, b) {
  return (
    a.tag === b.tag &&
    a.role === b.role &&
    a.name === b.name &&
    JSON.stringify(a.peers) === JSON.stringify(b.peers)
  );
}

/**
 * @param {{ gold: string[] | "none" | "ambiguous" }} testCase
 * @param {{
 *   status: "resolved" | "unresolved",
 *   reason?: string,
 *   pickedGold?: string | null,
 *   decisions: { options: { id: string, gold: string | null, tag: string, role: string, name: string, peers: string[] }[], probabilities: Record<string, number> }[],
 * }} observation
 */
export function scoreCase(testCase, observation) {
  const answerable = Array.isArray(testCase.gold);
  const golds = new Set(answerable ? testCase.gold : []);
  const isGold = (option) => !!option && golds.has(option.gold);
  const decisions = observation.decisions;
  const offered = decisions.flatMap((decision) => decision.options);
  const goldSeen = offered.some(isGold);
  const final = decisions.at(-1);
  const finalTop = final
    ? final.options.find((option) => option.id === argmax(final.probabilities))
    : undefined;
  const goldTop = isGold(finalTop);
  const goldProbability = final
    ? Math.max(
        0,
        ...final.options
          .filter(isGold)
          .map((option) => final.probabilities[option.id] ?? 0),
      )
    : null;
  const indistinguishable = decisions.some((decision) =>
    decision.options.some(
      (option) =>
        isGold(option) &&
        decision.options.some(
          (other) =>
            other !== option && !isGold(other) && sameProjection(option, other),
        ),
    ),
  );

  let outcome;
  let stage = null;
  if (observation.status === "resolved") {
    if (answerable && golds.has(observation.pickedGold)) outcome = "correct";
    else {
      outcome = "wrong_action";
      stage = !answerable ? "gate" : !goldSeen ? "recall" : "rank";
    }
  } else if (!answerable) {
    outcome = "correct_abstain";
  } else {
    outcome = "false_reject";
    const reason = observation.reason ?? "unknown";
    stage = OPERATIONAL.has(reason)
      ? `operational:${reason}`
      : !goldSeen
        ? "recall"
        : !goldTop
          ? "rank"
          : "gate";
  }
  return {
    outcome,
    stage,
    goldSeen: answerable ? goldSeen : null,
    goldTop: answerable ? goldTop : null,
    goldProbability: answerable ? goldProbability : null,
    indistinguishable,
    rounds: decisions.length,
  };
}

function rate(part, whole) {
  return whole === 0 ? null : part / whole;
}

/**
 * Success on answerable cases mixes two layers, so it is split in two.
 * Extraction: the share of answerable cases where a gold element was offered
 * to the model at all. Choice: of those, the share where the locator acted on
 * it; top pick is the share where the model ranked a gold element first, so
 * the gap between top pick and choice is the gate. Operational failures are
 * left out of both. Success is roughly extraction times choice.
 */
export function split(results) {
  const scored = results.filter(
    (item) =>
      Array.isArray(item.case.gold) &&
      !item.score.stage?.startsWith("operational:"),
  );
  const seen = scored.filter((item) => item.score.goldSeen);
  return {
    cases: scored.length,
    offered: seen.length,
    extraction: rate(seen.length, scored.length),
    choice: rate(
      seen.filter((item) => item.score.outcome === "correct").length,
      seen.length,
    ),
    topPick: rate(
      seen.filter((item) => item.score.goldTop).length,
      seen.length,
    ),
  };
}

/** Aggregate scored results into the headline metrics and breakdowns. */
export function summarize(results) {
  const count = (items, outcome) =>
    items.filter((item) => item.score.outcome === outcome).length;
  const answerable = results.filter((item) => Array.isArray(item.case.gold));
  const unanswerable = results.filter((item) => !Array.isArray(item.case.gold));
  const byTag = new Map();
  for (const item of results)
    for (const tag of item.case.tags ?? []) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(item);
    }
  const byVariant = new Map();
  for (const item of results)
    if (item.case.variant) {
      if (!byVariant.has(item.case.variant))
        byVariant.set(item.case.variant, []);
      byVariant.get(item.case.variant).push(item);
    }
  const stages = {};
  for (const item of results)
    if (item.score.stage)
      stages[item.score.stage] = (stages[item.score.stage] ?? 0) + 1;
  const usage = results
    .flatMap((item) => item.calls)
    .reduce(
      (total, call) => ({
        calls: total.calls + 1,
        inputTokens: total.inputTokens + (call.usage?.inputTokens ?? 0),
        costUsd:
          total.costUsd === null || call.totalCostUsd === null
            ? null
            : total.costUsd + (call.totalCostUsd ?? 0),
      }),
      { calls: 0, inputTokens: 0, costUsd: 0 },
    );
  return {
    cases: results.length,
    answerable: answerable.length,
    unanswerable: unanswerable.length,
    outcomes: {
      correct: count(results, "correct"),
      wrong_action: count(results, "wrong_action"),
      false_reject: count(results, "false_reject"),
      correct_abstain: count(results, "correct_abstain"),
    },
    successRate: rate(count(answerable, "correct"), answerable.length),
    wrongActionRate: rate(count(results, "wrong_action"), results.length),
    abstainRate: rate(
      count(unanswerable, "correct_abstain"),
      unanswerable.length,
    ),
    stages,
    split: split(results),
    tags: Object.fromEntries(
      [...byTag.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tag, items]) => [
          tag,
          {
            cases: items.length,
            ok: count(items, "correct") + count(items, "correct_abstain"),
            wrong: count(items, "wrong_action"),
          },
        ]),
    ),
    variants: Object.fromEntries(
      [...byVariant.entries()].map(([variant, items]) => {
        const answerableItems = items.filter((item) =>
          Array.isArray(item.case.gold),
        );
        return [
          variant,
          {
            cases: items.length,
            successRate: rate(
              count(answerableItems, "correct"),
              answerableItems.length,
            ),
            wrong: count(items, "wrong_action"),
            recall: items.filter((item) => item.score.stage === "recall")
              .length,
          },
        ];
      }),
    ),
    usage,
  };
}
