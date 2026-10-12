import { describe, expect, it } from "vitest";
import { Archive, returnPath, routeTemplate } from "./archive.js";
import {
  editsExistingRecord,
  fieldsToFill,
  formatTools,
  formatValue,
  type FieldInfo,
} from "./forms.js";
import { SeededRandom } from "./random.js";
import type { ExploreAction } from "./types.js";

const field = (hints: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  ref: hints,
  empty: true,
  invalid: false,
  required: true,
  type: "text",
  hints,
  ...extra,
});

describe("format rules", () => {
  const tools = formatTools(new SeededRandom(3));

  it("fills UK banking and identity formats", () => {
    expect(formatValue(field("sort code"), tools)?.value).toMatch(
      /^\d{2}-\d{2}-\d{2}$/u,
    );
    expect(
      formatValue(field("national insurance number"), tools)?.value,
    ).toMatch(/^QQ\d{6}[A-D]$/u);
    expect(formatValue(field("account id"), tools)?.value).toMatch(/^\d{8}$/u);
    expect(formatValue(field("balance 0.00"), tools)?.value).toMatch(
      /^\d+\.\d{2}$/u,
    );
    for (let i = 0; i < 20; i++)
      expect(formatValue(field("postcode"), tools)?.value).toMatch(
        /^[A-Z]{1,2}\d{1,2} \d[A-Z]{2}$/u,
      );
  });

  it("follows a pattern attribute before any label", () => {
    expect(
      formatValue(field("postcode", { pattern: "[0-9]{5}" }), tools)?.value,
    ).toMatch(/^\d{5}$/u);
  });

  it("fills date parts, UK postcodes, emails and ranges validly", () => {
    expect(
      Number(formatValue(field("dd day"), tools)?.value),
    ).toBeLessThanOrEqual(28);
    expect(Number(formatValue(field("mm"), tools)?.value)).toBeLessThanOrEqual(
      12,
    );
    const year = Number(formatValue(field("yyyy"), tools)?.value);
    expect(year).toBeGreaterThanOrEqual(1950);
    expect(year).toBeLessThanOrEqual(1995);
    expect(formatValue(field("postcode"), tools)?.value).toMatch(
      /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/iu,
    );
    expect(
      formatValue(field("email", { type: "email" }), tools)?.value,
    ).toMatch(/@example\.com$/u);
    const age = Number(
      formatValue(
        field("retirement age", { type: "number", min: 55, max: 75 }),
        tools,
      )?.value,
    );
    expect(age).toBeGreaterThanOrEqual(55);
    expect(age).toBeLessThanOrEqual(75);
  });

  it("never fills passwords and leaves unknown fields to the model", () => {
    expect(
      formatValue(field("password", { type: "password" }), tools)?.generator,
    ).toBe("format.password");
    expect(formatValue(field("favourite colour"), tools)).toBeNull();
  });

  it("leaves forms that edit an existing record alone", () => {
    const settings = [
      field("first name", { empty: false }),
      field("last name", { empty: false }),
      field("phone"),
    ];
    expect(editsExistingRecord(settings)).toBe(true);
    expect(editsExistingRecord([field("first name"), field("last name")])).toBe(
      false,
    );
  });

  it("retries only the fields the page flagged", () => {
    const fields = [field("dd", { empty: false, invalid: true }), field("mm")];
    expect(fieldsToFill(fields, true).map((f) => f.hints)).toEqual(["dd"]);
    expect(fieldsToFill(fields, false).map((f) => f.hints)).toEqual([
      "dd",
      "mm",
    ]);
  });
});

describe("archive", () => {
  const go = (name: string): ExploreAction => ({
    kind: "click",
    target: { role: "link", name, occurrence: 0 },
  });

  it("folds ids out of routes", () => {
    expect(
      routeTemplate(
        "/clients/78863d26-108d-43ca-bcf9-cb4901bf11f5/plans/12?tab=a",
      ),
    ).toBe("/clients/:id/plans/:id");
  });

  it("keeps the shortest clean path and never a path that wrote", () => {
    const archive = new Archive({ staleAfter: 2, maxPath: 10 });
    const from = (...actions: ExploreAction[]) => ({ start: "/", actions });
    archive.visit({
      key: "/a|form",
      url: "/a",
      episode: from(go("x"), go("y")),
      clean: true,
    });
    archive.visit({
      key: "/a|form",
      url: "/a?again",
      episode: from(go("y")),
      clean: true,
    });
    archive.visit({
      key: "/b|form",
      url: "/b",
      episode: from(go("z")),
      clean: false,
    });
    archive.untried("/a|form", 3);
    archive.untried("/b|form", 5);
    expect(archive.due()).toBe(false);
    archive.visit({
      key: "/a|form",
      url: "/a",
      episode: from(go("y")),
      clean: true,
    });
    archive.visit({
      key: "/a|form",
      url: "/a",
      episode: from(go("y")),
      clean: true,
    });
    expect(archive.due()).toBe(true);
    const cell = archive.pick(new SeededRandom(1), "/b|form");
    expect(cell?.key).toBe("/a|form");
    expect(cell?.path?.actions).toEqual([go("y")]);
    expect(archive.due()).toBe(false);
  });

  it("returns by URL first, and by path once the URL lands elsewhere", () => {
    const archive = new Archive({ staleAfter: 1, maxPath: 10 });
    archive.visit({
      key: "/a|form",
      url: "/a",
      episode: { start: "/", actions: [go("x")] },
      clean: true,
    });
    archive.visit({
      key: "/b|form",
      url: "/b",
      episode: { start: "/", actions: [] },
      clean: false,
    });
    archive.untried("/a|form", 1);
    archive.untried("/b|form", 1);
    const a = archive.pick(new SeededRandom(1), "/b|form")!;
    expect(returnPath(a)).toEqual([{ kind: "goto", url: "/a" }]);
    archive.arrived(a, "/home|home");
    expect(returnPath(a)).toEqual([{ kind: "goto", url: "/" }, go("x")]);
    const b = archive.pick(new SeededRandom(1), "/a|form")!;
    archive.arrived(b, "/home|home");
    // No clean path and no working URL: never picked again.
    expect(archive.pick(new SeededRandom(1), "/a|form")).toBeUndefined();
  });
});
