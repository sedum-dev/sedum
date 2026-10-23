import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import { PAGE_PROTOCOL } from "../page-protocol.js";
import type { TextClaim } from "../step-operands.js";
import type { SentenceAssertionContext } from "./assertion-support.js";
import { executeTextAssertion } from "./assertion-text.js";

/** A page whose text never becomes readable, as one stuck mid-navigation. */
function unreadablePage(): BrowserPage {
  const version = { revision: 1, document: "next", route: "/next" };
  return {
    url: "http://127.0.0.1/next",
    evaluate: async (script: string) => {
      const method = /bridge\["(\w+)"\]/u.exec(script)?.[1] ?? "";
      if (method === "visibleText") return { installed: false };
      const value = method === "quiet" ? { version, quiet: true } : version;
      return { installed: true, protocol: PAGE_PROTOCOL, value };
    },
  } as unknown as BrowserPage;
}

describe("text assertions", () => {
  it("fails, so retries can repeat it, when the text stays unreadable to the deadline", async () => {
    const record = vi.fn(async (outcome: unknown) => outcome);
    const context = {
      page: unreadablePage(),
      data: {},
      dependencies: {},
      step: { source: { file: "flow.test.yaml", line: 1, col: 1 } },
      record,
    } as unknown as SentenceAssertionContext;
    const claim: TextClaim = {
      text: "Arrived",
      expect: { kind: "present", present: true },
    };
    const started = performance.now();
    await executeTextAssertion(context, claim, 600);
    expect(performance.now() - started).toBeGreaterThanOrEqual(500);
    expect(record).toHaveBeenCalledWith("failed", {
      error: {
        code: "text_unreadable",
        message: "The page text could not be read.",
      },
    });
  });
});
