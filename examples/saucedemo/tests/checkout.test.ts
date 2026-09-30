import { faker } from "@faker-js/faker";
import { test, expect, secret } from "sedum-cli";
import { cartIds, money, PRODUCTS } from "./support/saucedemo.js";

test(
  "a new customer checks out two items",
  { url: "/", tags: ["checkout"] },
  async ({ page, ai, env }) => {
    const customer = {
      first: faker.person.firstName(),
      last: faker.person.lastName(),
      postcode: faker.location.zipCode("#####"),
    };

    await ai.group(
      "Log in",
      [
        "type {{user}} in the username field",
        "type {{password}} in the password field",
        "click the login button",
      ],
      {
        user: "standard_user",
        password: secret(env.SAUCE_PASSWORD ?? "secret_sauce"),
      },
    );

    await ai.group("Fill the cart", async () => {
      await ai("click the Add to cart button for Sauce Labs Backpack");
      await ai("click the Add to cart button for {{product}}", {
        product: "Sauce Labs Onesie",
      });

      // Check the badge with a locator, and the app's own state behind it.
      await expect(page.locator(".shopping_cart_badge")).toHaveText("2");
      expect(await cartIds(page)).toEqual(
        expect.arrayContaining([
          PRODUCTS["Sauce Labs Backpack"],
          PRODUCTS["Sauce Labs Onesie"],
        ]),
      );
    });

    await ai.group("Checkout", async () => {
      await ai("click the shopping cart link");
      await ai("click the Checkout button");
      await ai("type {{first}} in the First Name field", customer);
      await ai("type {{last}} in the Last Name field", customer);
      await ai("type {{postcode}} in the Zip/Postal Code field", customer);
      await ai("click the Continue button");
    });

    await ai.group("Review the order", async () => {
      await ai(
        "verify the order summary lists Sauce Labs Backpack and Sauce Labs Onesie",
      );
      const subtotal = await ai.extract("the item total", {
        parse: (text) => money(String(text)),
      });
      const prices = await page
        .locator(".inventory_item_price")
        .allInnerTexts();
      expect(subtotal).toBeCloseTo(
        prices.map(money).reduce((sum, price) => sum + price, 0),
      );
    });

    await ai("click the Finish button");
    await ai("verify the order was placed and a confirmation message is shown");
  },
);
