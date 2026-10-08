import { test, expect } from "sedum-cli";

test(
  "repeated catalog controls preserve meaningful grammar words",
  { url: "/catalog" },
  async ({ page, ai }) => {
    await ai("click the Buy button for Button Camera");
    await expect(page.locator("#result")).toHaveText(
      "Purchase confirmation: Purchased Button Camera",
    );
    await ai("verify the purchase confirmation says Purchased Button Camera");
    await ai("click the Buy button for Link Camera");
    await expect(page.locator("#result")).toHaveText(
      "Purchase confirmation: Purchased Link Camera",
    );
    await ai("verify the purchase confirmation says Purchased Link Camera");
  },
);
