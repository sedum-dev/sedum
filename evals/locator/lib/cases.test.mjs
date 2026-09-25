import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { goldIds, loadSuites } from "./cases.mjs";

describe("goldIds", () => {
  it("finds labels in markup, srcdoc, and script strings", () => {
    const ids = goldIds(
      `<a data-eval-gold="a">A</a><iframe srcdoc="<b data-eval-gold=&quot;b&quot;>"></iframe>` +
        `<script>x.innerHTML = '<i data-eval-gold="c">'; y = "<i data-eval-gold=\\"d\\">";</script>`,
    );
    expect([...ids.keys()]).toEqual(["a", "b", "c", "d"]);
  });
});

describe("loadSuites", () => {
  let root;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));

  function write(page, suite) {
    root = mkdtempSync(join(tmpdir(), "locator-cases-"));
    mkdirSync(join(root, "pages"));
    mkdirSync(join(root, "cases"));
    writeFileSync(join(root, "pages", "p.html"), page);
    writeFileSync(join(root, "cases", "p.json"), JSON.stringify(suite));
  }

  it("accepts a well-formed suite", () => {
    write(`<button data-eval-gold="save">Save</button>`, {
      page: "p.html",
      cases: [
        {
          id: "p-save",
          op: "click",
          sentence: "click Save",
          gold: ["save"],
          tags: ["exact-label"],
        },
        {
          id: "p-none",
          op: "click",
          sentence: "click Undo",
          gold: "none",
          tags: ["absent"],
        },
      ],
    });
    const { cases, problems } = loadSuites(root);
    expect(problems).toEqual([]);
    expect(cases.map((c) => c.page)).toEqual(["p.html", "p.html"]);
  });

  it("reports labels, ids, and fields that would make a case meaningless", () => {
    write(`<a data-eval-gold="x">1</a><a data-eval-gold="x">2</a>`, {
      page: "p.html",
      cases: [
        {
          id: "dup",
          op: "click",
          sentence: "click 1",
          gold: ["missing"],
          tags: ["t"],
        },
        { id: "dup", op: "hover", sentence: "", gold: "maybe", tags: [] },
      ],
    });
    const text = loadSuites(root).problems.join("\n");
    expect(text).toMatch(/gold id x appears 2 times/);
    expect(text).toMatch(/gold missing is not marked/);
    expect(text).toMatch(/duplicate case id/);
    expect(text).toMatch(/op must be/);
    expect(text).toMatch(/missing sentence/);
    expect(text).toMatch(/at least one tag/);
    expect(text).toMatch(/gold must be ids/);
  });
});
