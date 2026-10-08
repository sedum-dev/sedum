import { test, expect, secret } from "sedum-cli";

test(
  "current values and ordinary unique buttons",
  { url: "/settings" },
  async ({ page, ai, env }) => {
    const values = {
      display: env.CACHE_DISPLAY ?? "Ada",
      password: secret(env.CACHE_PASSWORD ?? "local-fixture-password"),
    };
    await ai("type {{display}} in the Display Name field", values);
    await ai("type {{password}} in the Password field", values);
    await expect(page.locator("#display")).toHaveValue(
      env.CACHE_DISPLAY ?? "Ada",
    );
    await expect(page.locator("#password")).toHaveValue(
      env.CACHE_PASSWORD ?? "local-fixture-password",
    );
    await ai("click the Save button");
    await expect(page.locator("#result")).toHaveText(
      "Confirmation: Saved settings",
    );
    await ai("verify the confirmation says Saved settings");
    await ai("click the Finish button");
    await expect(page.locator("#result")).toHaveText(
      "Confirmation: Finished setup",
    );
    await ai("verify the confirmation says Finished setup");
  },
);
