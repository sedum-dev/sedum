# sedum-cli

Write browser tests in plain English, keep the full power of TypeScript, and run the whole suite on every pull request for dollars a month instead of thousands.

![Sedum running a plain-English login test in a real browser: it passes with 0.98 confidence for under a cent](https://raw.githubusercontent.com/sedum-dev/sedum/main/docs/assets/demo.gif)

Sedum is an open-source (MIT) browser end-to-end test runner built on Playwright. Each step is a sentence such as `await ai("click the Checkout button")`. Sedum finds the element on the page with a fast decision model and your own API key. Clicking, typing, waiting, verdicts, and exit codes are deterministic Playwright.

> **Status: pre-alpha.** The test format may change before 1.0, and Windows is experimental. Linux and macOS are verified.

## Try it

You need Node.js 20.19 or newer and credentials for TypeSafe Jev (the default) or Cloudflare Clef.

```sh
mkdir my-sedum-tests && cd my-sedum-tests
npm init -y
git init                              # locator results are cached in Git metadata
npm install -D sedum-cli
npx sedum init                        # an example test, config, and .env.example
npx sedum browsers install chromium   # if init says it is missing
cp .env.example .env                  # then set TYPESAFE_API_KEY in .env
npx sedum run tests/example.test.ts --headed
```

To see a failure, change the last step to a false claim, such as `verify an error message says the password is incorrect`, and run it again. It fails with exit code 1 and says how sure it is. If anything is missing, `npx sedum doctor` says what and how to fix it.

## A test

```ts
import { secret, test } from "sedum-cli";

test(
  "a customer logs in",
  { url: "https://www.saucedemo.com/" },
  async ({ ai, env }) => {
    await ai("type standard_user in the username field");
    await ai("type {{password}} in the password field", {
      password: secret(env.SAUCE_PASSWORD!),
    });
    await ai("click the login button");
    await ai("verify a list of products with prices is shown");
  },
);
```

Between steps you can use Playwright's `page` and `expect`, any test-data library, and API calls. Tests can also be plain YAML files with a list of sentences.

## Why Sedum

- **Cheap enough for every PR.** In the project's own benchmark, a 20-person team's pull request suite costs $38 to $91 a month on Sedum with Jev, against $4,875 at a per-step platform's published rates. Method and caveats are on [sedum.dev](https://sedum.dev).
- **Probabilities, not guesses.** Every claim is scored against a threshold and checked for contradicting evidence, so a marginal pass is flagged instead of silently green.
- **No black box.** Prompts, scoring, and caching are in the repository.
- **Made for coding agents.** `npx sedum run --reporter markdown` writes a failure report that Claude Code or Cursor can read and fix from.

## Documentation

- [Full README and quickstart](https://github.com/sedum-dev/sedum#readme)
- [CLI commands](https://github.com/sedum-dev/sedum/blob/main/docs/cli.md)
- [Running in CI](https://github.com/sedum-dev/sedum/blob/main/docs/ci.md)
- [Project configuration](https://github.com/sedum-dev/sedum/blob/main/docs/configuration.md)
- [Report an issue](https://github.com/sedum-dev/sedum/issues)

MIT licensed.
