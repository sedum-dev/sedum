import { describe, expect, it } from "vitest";
import { renderHtml } from "./html.js";
import { renderJunit } from "./junit.js";
import { renderMarkdown } from "./markdown.js";
import { detectionTexts } from "./shared.js";
import { fixtures } from "./test-fixtures.js";

describe("bug-detector findings in reports", () => {
  it("flags the test and step without failing them", async () => {
    const result = await fixtures.suspectedBug();
    expect(result.verdict).toBe("passed");
    expect(result.flags).toEqual(["suspected_bug"]);
    expect(result.totals.flaggedSteps).toBe(1);
  });

  it("describes each finding with its source, probability and severity", async () => {
    const step = (await fixtures.suspectedBug()).tests[0]!.attempts[0]!
      .steps[0]!;
    expect(detectionTexts(step)).toEqual([
      "suspected bug: http_error (browser): POST https://shop.test/api/coupon returned 500 Internal Server Error",
      "suspected bug: error_message (model p=0.98, severity 2.9/3): Page appears to show an error to the user",
    ]);
  });

  it("shows findings on the flagged step in every file reporter", async () => {
    const result = await fixtures.suspectedBug();
    const markdown = renderMarkdown(result);
    expect(markdown).toContain("passed, flagged");
    expect(markdown).toContain("suspected bug: http\\_error (browser)");
    const junit = renderJunit(result, {
      strict: true,
      evidenceDirectory: null,
    });
    expect(junit).toContain("suspected_bug 1");
    expect(junit).toContain("suspected bug: error_message (model p=0.98");
    expect(renderHtml(result)).toContain(
      "suspected bug: http_error (browser): POST https://shop.test/api/coupon",
    );
  });
});
