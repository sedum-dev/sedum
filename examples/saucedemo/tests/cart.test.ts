import { faker } from "@faker-js/faker";
import { test, expect } from "sedum-cli";
import {
  cartIds,
  PRODUCTS,
  signInAs,
  type ProductName,
} from "./support/saucedemo.js";

const names = Object.keys(PRODUCTS) as ProductName[];

test(
  "random products land in the cart",
  { tags: ["cart"] },
  async ({ page, context, ai }) => {
    // Bypass the login form entirely: set the session cookie from code.
    await signInAs(context, page, "standard_user");

    const picks = faker.helpers.arrayElements(names, { min: 2, max: 3 });
    for (const product of picks)
      await ai("click the Add to cart button for {{product}}", { product });

    await expect(page.locator(".shopping_cart_badge")).toHaveText(
      String(picks.length),
    );
    expect((await cartIds(page)).sort()).toEqual(
      picks.map((name) => PRODUCTS[name]).sort(),
    );
  },
);

test(
  "a seeded cart can be emptied",
  { tags: ["cart"] },
  async ({ page, context, ai }) => {
    // Seed state the UI would take many steps to build.
    await signInAs(context, page, "standard_user", [
      "Sauce Labs Bike Light",
      "Sauce Labs Fleece Jacket",
    ]);
    await ai("click the shopping cart link");
    await ai(
      "verify the cart lists Sauce Labs Bike Light and Sauce Labs Fleece Jacket",
    );
    await ai("click the Remove button for Sauce Labs Bike Light");
    await ai("click the Remove button for Sauce Labs Fleece Jacket");
    // A negative claim is clearer as a locator check than as an AI claim.
    await expect(page.locator(".cart_item")).toHaveCount(0);
    expect(await cartIds(page)).toEqual([]);
  },
);
