import { test, expect, secret } from "sedum-cli";

test(
  "a standard user signs in",
  { url: "/", tags: ["smoke"] },
  async ({ page, ai, env }) => {
    await ai("type {{user}} in the username field", { user: "standard_user" });
    await ai("type {{password}} in the password field", {
      password: secret(env.SAUCE_PASSWORD ?? "secret_sauce"),
    });
    await ai("click the login button");

    // Deterministic Playwright check between AI steps.
    await expect(page).toHaveURL(/inventory\.html$/);
    await ai("verify a list of products with prices is shown");
  },
);

test("a locked-out user sees why", { url: "/" }, async ({ ai, env }) => {
  await ai(
    [
      "type {{user}} in the username field",
      "type {{password}} in the password field",
      "click the login button",
      "verify an error says this user has been locked out",
    ],
    {
      user: "locked_out_user",
      password: secret(env.SAUCE_PASSWORD ?? "secret_sauce"),
    },
  );
});
