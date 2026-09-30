import { describe, expect, it } from "vitest";
import { chooseOption } from "./dropdown-option.js";

const sort = [
  "Name (A to Z)",
  "Name (Z to A)",
  "Price (low to high)",
  "Price (high to low)",
];

describe("dropdown option choice", () => {
  it("prefers a quoted option label", () => {
    expect(
      chooseOption('select "Price (low to high)" in the sort dropdown', sort),
    ).toBe("Price (low to high)");
    expect(
      chooseOption(
        'click the "price (LOW to high)" option in the sort dropdown',
        sort,
      ),
    ).toBe("Price (low to high)");
  });

  it("finds an unquoted label named as whole words", () => {
    expect(
      chooseOption("choose Price (high to low) from the sort dropdown.", sort),
    ).toBe("Price (high to low)");
    expect(
      chooseOption("pick Canada from the country list", ["Can", "Canada"]),
    ).toBe("Canada");
    expect(chooseOption("pick Cana from the list", ["Canada"])).toBeNull();
  });

  it("returns null when no option or several options are named", () => {
    expect(chooseOption("click the sort dropdown", sort)).toBeNull();
    expect(
      chooseOption('select "Name (A to Z)" or "Name (Z to A)"', sort),
    ).toBeNull();
    expect(chooseOption("select Yes or No", ["Yes", "No"])).toBeNull();
  });
});
