import type { BrowserPage } from "../browser-driver.js";
import {
  readPageVersion,
  revealValues,
  waitForPageChange,
  type SentenceAssertionContext,
} from "./assertion-support.js";
import { unsupported } from "./support.js";
import { quietPage, visibleText } from "../page-bridge.js";
import { countText, type TextClaim } from "../step-operands.js";

async function readableText(page: BrowserPage) {
  const text = await visibleText(page);
  if (text === null) throw new Error("The page text could not be read.");
  return text;
}

function textCount(
  page: BrowserPage,
  text: string,
  claim: TextClaim,
  body: string,
) {
  if (claim.expect.kind === "url") return Number(page.url.includes(text));
  return countText(body, text, claim.ignoreCase);
}

async function countMatches(
  context: SentenceAssertionContext,
  claim: TextClaim,
  wanted: readonly string[],
) {
  const body =
    claim.expect.kind === "url" ? "" : await readableText(context.page);
  return wanted.reduce(
    (sum, text) => sum + textCount(context.page, text, claim, body),
    0,
  );
}

function expectationHolds(claim: TextClaim, found: number) {
  const expected = claim.expect;
  if (expected.kind === "present") return found > 0 === expected.present;
  if (expected.kind === "url") return found > 0 === expected.contains;
  return found === expected.count;
}

function failureMessage(claim: TextClaim, found: number) {
  if (claim.expect.kind === "url") {
    return `The page address ${found ? "contains" : "does not contain"} the text.`;
  }
  if (found === 0) return "The text is not on the page.";
  const frequency = found === 1 ? "once" : `${found} times`;
  return `The text appears ${frequency} on the page.`;
}

function unreadable(context: SentenceAssertionContext) {
  const message = "The page text could not be read.";
  return context.record(
    unsupported(context.step.source.file, context.step.source, message),
    { error: { code: "text_unreadable", message } },
  );
}

function lastReadFailure(
  context: SentenceAssertionContext,
  claim: TextClaim,
  found: number | null,
) {
  if (found === null) return unreadable(context);
  const message = failureMessage(claim, found);
  return context.record("failed", { error: { code: "text_check", message } });
}

export async function executeTextAssertion(
  context: SentenceAssertionContext,
  claim: TextClaim,
  limitMs: number,
) {
  const deadline = performance.now() + limitMs;
  const wanted = (claim.alternatives ?? [claim.text]).map((text) =>
    revealValues(text, context.data),
  );
  // A page mid-navigation cannot be read yet; like absent text, that is
  // "not yet" until the deadline, and it is read again shortly.
  let found: number | null = null;
  for (;;) {
    const before = await readPageVersion(context.page);
    await quietPage(context.page, 80, 2_000).catch(() => undefined);
    found = await countMatches(context, claim, wanted).catch(() => null);
    if (found !== null && expectationHolds(claim, found))
      return context.record("continue");
    const since = found === null ? null : before;
    if (!(await waitForPageChange(context, since, deadline, false))) break;
  }
  return lastReadFailure(context, claim, found);
}
