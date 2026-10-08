import { test, expect, secret } from "sedum-cli";
import { cartIds, money, PRODUCTS } from "./support/saucedemo.js";

test(
  "a customer checks out two items with sentences",
  { url: "/" },
  async ({ page, ai, env }) => {
    await ai("type {{user}} in the username field", { user: "standard_user" });
    await ai("type {{password}} in the password field", {
      password: secret(env.SAUCE_PASSWORD ?? "secret_sauce"),
    });
    await ai("click the login button");
    await ai("click the Add to cart button for Sauce Labs Backpack");
    await ai("click the Add to cart button for Sauce Labs Onesie");
    await expect(page.locator(".shopping_cart_badge")).toHaveText("2");
    expect(await cartIds(page)).toEqual(
      expect.arrayContaining([
        PRODUCTS["Sauce Labs Backpack"],
        PRODUCTS["Sauce Labs Onesie"],
      ]),
    );
    await ai("click the shopping cart link");
    await ai("click the Checkout button");
    const customer = { first: "Ada", last: "Lovelace", postcode: "94016" };
    await ai("type {{first}} in the First Name field", customer);
    await ai("type {{last}} in the Last Name field", customer);
    await ai("type {{postcode}} in the Zip/Postal Code field", customer);
    await ai("click the Continue button");
    await expect(page).toHaveURL(/checkout-step-two\.html$/);
    await ai(
      "verify the order summary lists Sauce Labs Backpack and Sauce Labs Onesie",
    );
    const subtotal = money(
      await page.locator(".summary_subtotal_label").innerText(),
    );
    const prices = await page.locator(".inventory_item_price").allInnerTexts();
    expect(subtotal).toBeCloseTo(
      prices.map(money).reduce((sum, price) => sum + price, 0),
    );
    await ai("click the Finish button");
    await ai("verify the order was placed and a confirmation message is shown");
  },
);
