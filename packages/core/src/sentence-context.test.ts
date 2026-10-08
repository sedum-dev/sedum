import { describe, expect, it } from "vitest";
import { contestedControlNoun, contextClues } from "./sentence-context.js";

const button = (name: string, ref = name) => ({ ref, name, role: "button" });
const link = (name: string, ref = name) => ({ ref, name, role: "link" });
const textbox = (name: string) => ({ ref: name, name, role: "textbox" });

describe("sentence context clues", () => {
  it.each([
    ["click the Checkout button", button("Checkout")],
    ["Click the FINISH Button", button("Finish")],
    ["click the button Checkout", button("Checkout")],
    ["click the Docs link", link("Docs")],
    ["click the Add to cart button", button("Add to cart")],
    ["click the Checkout button", button("Checkout button")],
  ])("treats a role noun beside the label as grammar: %s", (sentence, c) => {
    expect(contextClues(sentence, c, [c])).toEqual([]);
  });

  it.each([
    ["click the Checkout link", button("Checkout"), ["link"]],
    ["click the Help button", link("Help"), ["button"]],
    [
      "click Add to cart for the Red Button",
      button("Add to cart"),
      ["red", "button"],
    ],
    [
      "click the button labeled Checkout",
      button("Checkout"),
      ["button", "labeled"],
    ],
    [
      "click the Checkout button not Cancel",
      button("Checkout"),
      ["not", "cancel"],
    ],
    ["type {{email}} into the Email field", textbox("Email"), ["into"]],
  ])("keeps meaningful words: %s", (sentence, c, expected) => {
    expect(contextClues(sentence, c, [c])).toEqual(expected);
  });

  it("drops only the occurrence that names the control", () => {
    const c = button("Checkout");
    expect(
      contextClues("click the Checkout button near the Button Mushroom", c, [
        c,
      ]),
    ).toEqual(["near", "button", "mushroom"]);
  });

  it("keeps the noun when another control of the same role is named with it", () => {
    const c = button("Checkout");
    const sentence = "click the Checkout button";
    expect(contextClues(sentence, c, [c, button("Checkout button")])).toEqual([
      "button",
    ]);
    expect(contextClues(sentence, c, [c, button("Radio button help")])).toEqual(
      ["button"],
    );
    expect(contextClues(sentence, c, [c, link("Help button")])).toEqual([]);
    expect(contextClues(sentence, c, [c, button("Checkout now")])).toEqual([]);
  });

  it("ignores runtime placeholders and same-ref entries", () => {
    const c = button("Checkout");
    expect(contextClues("click {{button}} Checkout", c, [c])).toEqual([]);
    expect(contextClues("click the Checkout button", c, [c, { ...c }])).toEqual(
      [],
    );
  });

  it("reports a contested noun only when another current control claims it", () => {
    const c = button("Checkout");
    const competitor = button("Checkout button");
    expect(contestedControlNoun("click the Checkout button", c, [c])).toBe(
      false,
    );
    expect(
      contestedControlNoun("click the Checkout button", c, [c, competitor]),
    ).toBe(true);
    expect(contestedControlNoun("click Checkout", c, [c, competitor])).toBe(
      false,
    );
    expect(
      contestedControlNoun("click the Checkout link", c, [c, competitor]),
    ).toBe(false);
    expect(
      contestedControlNoun("click the Checkout button", competitor, [
        c,
        competitor,
      ]),
    ).toBe(false);
    expect(
      contestedControlNoun("type Ann into the Name field", textbox("Name"), []),
    ).toBe(false);
    expect(contestedControlNoun("click the button", button(""), [])).toBe(
      false,
    );
  });
});
