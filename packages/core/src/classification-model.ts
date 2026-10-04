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

export function evaluateModelAnswer(
  answer: ModelClassification | CachedClassification,
): ModelDecision {
  if (!hasValidChoices(answer)) return { accepted: false, reason: "invalid" };
  const values = MODEL_CHOICES.map((key) => answer.probabilities[key]);
  if (values.some((probability) => !validProbability(probability)))
    return { accepted: false, reason: "invalid" };
  const sum = values.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) >= 0.02) return { accepted: false, reason: "invalid" };
  const chosen = answer.probabilities[answer.op];
  const sorted = [...values].sort((a, b) => b - a);
  if (sorted[0]! - chosen > 1e-6) return { accepted: false, reason: "invalid" };
  if (answer.op === "unsupported_or_unclear")
    return { accepted: false, reason: "unsupported" };
  if (answer.op === "multiple_actions")
    return { accepted: false, reason: "multiple_actions" };
  if (chosen < MIN_MODEL_PROBABILITY || chosen - sorted[1]! < MIN_MODEL_MARGIN)
    return { accepted: false, reason: "ambiguous" };
  return { accepted: true, probability: chosen };
}
