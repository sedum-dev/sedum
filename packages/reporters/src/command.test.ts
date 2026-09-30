import { describe, expect, it } from "vitest";
import { renderHtml } from "./html.js";
import { renderJunit } from "./junit.js";
import { renderMarkdown } from "./markdown.js";
import { fixtures } from "./test-fixtures.js";

describe("rerun hints name the invoking command", () => {
  it("keeps bare sedum by default and uses npx sedum when asked", async () => {
    const result = await fixtures.failedVerify();
    const junit = { strict: false, evidenceDirectory: null };
    expect(renderMarkdown(result)).toContain("`sedum run ");
    expect(renderHtml(result)).toContain("<code>sedum run ");
    expect(renderJunit(result, junit)).toContain("rerun: sedum run ");

    const markdown = renderMarkdown(result, { command: "npx sedum" });
    const html = renderHtml(result, { command: "npx sedum" });
    const xml = renderJunit(result, { ...junit, command: "npx sedum" });
    expect(markdown).toContain("`npx sedum run ");
    expect(markdown).not.toContain("`sedum run ");
    expect(html).toContain("<code>npx sedum run ");
    expect(html).not.toContain("<code>sedum run ");
    expect(xml).toContain("rerun: npx sedum run ");
    expect(xml).not.toContain("rerun: sedum run ");
  });
});
