import {
  MIN_MODEL_MARGIN,
  MIN_MODEL_PROBABILITY,
  MODEL_CHOICES,
  type CachedClassification,
  type ModelChoice,
  type ModelClassification,
} from "./classification-contracts.js";

export type ModelDecision =
  | { readonly accepted: true; readonly probability: number }
  | {
      readonly accepted: false;
      readonly reason:
        "invalid" | "ambiguous" | "unsupported" | "multiple_actions";
    };

function hasValidChoices(answer: ModelClassification | CachedClassification) {
  if (!MODEL_CHOICES.includes(answer.op as ModelChoice)) return false;
  const keys = Object.keys(answer.probabilities);
  return (
    keys.length === MODEL_CHOICES.length &&
    keys.every((key) => MODEL_CHOICES.includes(key as ModelChoice))
  );
}

function validProbability(probability: number): boolean {
  return (
    typeof probability === "number" &&
    Number.isFinite(probability) &&
    probability >= 0 &&
    probability <= 1
  );
}

interface ProbabilitySummary {
  readonly chosen: number;
  readonly highest: number;
  readonly runnerUp: number;
}

function probabilitySummary(
  answer: ModelClassification | CachedClassification,
): ProbabilitySummary | null {
  const values = MODEL_CHOICES.map((key) => answer.probabilities[key]);
  if (values.some((probability) => !validProbability(probability))) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) >= 0.02) return null;
  const sorted = [...values].sort((a, b) => b - a);
  return {
    chosen: answer.probabilities[answer.op],
    highest: sorted[0]!,
    runnerUp: sorted[1]!,
  };
}

function executableDecision(
  answer: ModelClassification | CachedClassification,
  probabilities: ProbabilitySummary,
): ModelDecision {
  if (answer.op === "unsupported_or_unclear")
    return { accepted: false, reason: "unsupported" };
  if (answer.op === "multiple_actions")
    return { accepted: false, reason: "multiple_actions" };
  if (
    probabilities.chosen < MIN_MODEL_PROBABILITY ||
    probabilities.chosen - probabilities.runnerUp < MIN_MODEL_MARGIN
  )
    return { accepted: false, reason: "ambiguous" };
  return { accepted: true, probability: probabilities.chosen };
}

export function evaluateModelAnswer(
  answer: ModelClassification | CachedClassification,
): ModelDecision {
  if (!hasValidChoices(answer)) return { accepted: false, reason: "invalid" };
  const probabilities = probabilitySummary(answer);
  if (!probabilities || probabilities.highest - probabilities.chosen > 1e-6)
    return { accepted: false, reason: "invalid" };
  return executableDecision(answer, probabilities);
}
