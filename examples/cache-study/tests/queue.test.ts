import { test, expect } from "sedum-cli";

test(
  "same person and action in separate named queues",
  { url: "/queue" },
  async ({ page, ai }) => {
    await ai("click the Approve button for Alice in Pending");
    await expect(page.locator("#result")).toHaveText("pending");
    await ai("verify the result is pending");
    await ai("click the Approve button for Alice in Archived");
    await expect(page.locator("#result")).toHaveText("archived");
    await ai("verify the result is archived");
  },
);
