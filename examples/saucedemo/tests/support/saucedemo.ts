import type { BrowserContext, Page } from "sedum-cli";

/** Product ids Sauce Demo keeps in localStorage under `cart-contents`. */
export const PRODUCTS = {
  "Sauce Labs Backpack": 4,
  "Sauce Labs Bike Light": 0,
  "Sauce Labs Bolt T-Shirt": 1,
  "Sauce Labs Fleece Jacket": 5,
  "Sauce Labs Onesie": 2,
  "Test.allTheThings() T-Shirt (Red)": 3,
} as const;

export type ProductName = keyof typeof PRODUCTS;

/**
 * Skip the login form: Sauce Demo trusts a `session-username` cookie, and
 * keeps the cart in localStorage. Setting both is the "API login" of this site.
 */
export async function signInAs(
  context: BrowserContext,
  page: Page,
  username: string,
  cart: readonly ProductName[] = [],
): Promise<void> {
  await context.addCookies([
    {
      name: "session-username",
      value: username,
      url: "https://www.saucedemo.com",
    },
  ]);
  await page.goto("https://www.saucedemo.com/");
  await page.evaluate(
    (ids: number[]) =>
      localStorage.setItem("cart-contents", JSON.stringify(ids)),
    cart.map((name) => PRODUCTS[name]),
  );
  await page.goto("https://www.saucedemo.com/inventory.html");
}

/** Read the cart the way the app stores it, to check state behind the UI. */
export async function cartIds(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("cart-contents") ?? "[]"),
  );
}

export function money(text: string): number {
  const match = /\$?(\d+(?:\.\d+)?)/u.exec(text);
  if (!match) throw new Error(`No amount in ${JSON.stringify(text)}`);
  return Number(match[1]);
}
