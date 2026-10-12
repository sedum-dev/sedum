import { describe, expect, it } from "vitest";
import { labelInLine, RULE_JUDGE } from "./form-judge.js";
import { newErrorLines, PLACEHOLDER } from "./forms.js";
import type { Observation } from "./observe.js";
import { samplePattern, valueForError } from "./pattern-sample.js";
import { SeededRandom } from "./random.js";

describe("summary errors", () => {
  it("keeps only error lines a submit added", () => {
    expect(
      newErrorLines(
        ["Account name", "Balance", "Please keep this private"],
        [
          "Account name",
          "Balance",
          "Please keep this private",
          "Error: Incomplete information",
          "Wrapper type is required",
        ],
      ),
    ).toEqual(["Error: Incomplete information", "Wrapper type is required"]);
  });

  it("names the longest label a line mentions", () => {
    const labels = ["Account name", "Account ID", "Postcode (optional)", "ID"];
    expect(labelInLine("Account ID must be 8 digits", labels)).toBe(1);
    expect(labelInLine("Postcode is not valid", labels)).toBe(2);
    expect(labelInLine("Error: Incomplete information", labels)).toBeNull();
  });

  it("states a format outright when the error gives a length", () => {
    const random = new SeededRandom(2);
    expect(valueForError("Adviser code must be 6 digits", random)).toMatch(
      /^\d{6}$/u,
    );
    expect(valueForError("Use at least 8 characters", random)).toMatch(
      /^[A-Z]{8}$/u,
    );
    expect(valueForError("Balance must be a number", random)).toMatch(/^\d+$/u);
    expect(valueForError("Wrapper type is required", random)).toBeNull();
  });
});

describe("patterns", () => {
  it("samples simple HTML patterns and refuses richer ones", () => {
    const random = new SeededRandom(4);
    for (const pattern of [
      "\\d{5}",
      "[A-Z]{2}[0-9]{6}[A-D]",
      "[0-9]{2}-[0-9]{2}-[0-9]{2}",
      "GB\\d{2}[A-Z]{4}\\d{14}",
    ]) {
      const value = samplePattern(pattern, random);
      expect(value).not.toBeNull();
      expect(new RegExp(`^(?:${pattern})$`, "u").test(value!)).toBe(true);
    }
    expect(samplePattern("(yes|no)", random)).toBeNull();
    expect(samplePattern("[^0-9]+", random)).toBeNull();
  });
});

describe("dropdowns and settings", () => {
  it("recognises placeholder text, not actions", () => {
    for (const shown of [
      "Select a wrapper type",
      "Choose…",
      "Please select",
      "--",
    ])
      expect(PLACEHOLDER.test(shown)).toBe(true);
    for (const shown of ["Select all", "Choose file", "GIA", "Selected funds"])
      expect(PLACEHOLDER.test(shown)).toBe(false);
  });

  it("treats settings routes as settings without a model", async () => {
    const at = (route: string) => ({ route }) as Observation;
    expect(
      await RULE_JUDGE.purpose(at("/planning/account_settings/edit"), []),
    ).toBe("settings");
    expect(await RULE_JUDGE.purpose(at("/clients/1/accounts"), [])).toBe(
      undefined,
    );
  });
});
