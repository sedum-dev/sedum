import { executeControlAssertion } from "./assertion-control.js";
import { executeModelAssertion } from "./assertion-model.js";
import { executeTextAssertion } from "./assertion-text.js";
import type { SentenceAssertionContext } from "./assertion-support.js";
import { CLAIM_PREFIX } from "./support.js";
import {
  elementClaim,
  textClaim,
  waitUntilTimeoutMs,
} from "../step-operands.js";

export type {
  AssertionFacts,
  SentenceAssertionContext,
} from "./assertion-support.js";

function verificationTimeout(context: SentenceAssertionContext) {
  if (context.step.op !== "verify") return null;
  return waitUntilTimeoutMs(context.step.text);
}

function gracePeriod(context: SentenceAssertionContext) {
  if (context.check) return 0;
  return context.dependencies.verifyGraceMs ?? 0;
}

export async function executeAssertion(context: SentenceAssertionContext) {
  const assertionText = context.step.text.replace(CLAIM_PREFIX, "");
  const limitMs = verificationTimeout(context) ?? gracePeriod(context);
  if (context.step.op === "verify") {
    const quoted = textClaim(assertionText);
    if (quoted) return executeTextAssertion(context, quoted, limitMs);
    const element = elementClaim(assertionText);
    if (element) return executeControlAssertion(context, element, limitMs);
  }
  return executeModelAssertion(
    context,
    assertionText,
    verificationTimeout(context),
    gracePeriod(context),
  );
}
