# Sauce Demo in TypeScript

A small Sedum suite for [Sauce Demo](https://www.saucedemo.com/), written as
TypeScript tests. It shows what code between plain-English steps is for:

| File                                                       | Shows                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [`tests/login.test.ts`](tests/login.test.ts)               | Two tests in one file, `secret()`, a list of steps with shared values, and a Playwright URL check.        |
| [`tests/checkout.test.ts`](tests/checkout.test.ts)         | Customer data from faker, `ai.group`, locator and app-state checks mid-flow, and `ai.extract` of a total. |
| [`tests/cart.test.ts`](tests/cart.test.ts)                 | Skipping the login form with a session cookie, seeding the cart in `localStorage`, and random products.   |
| [`tests/support/saucedemo.ts`](tests/support/saucedemo.ts) | Plain helper functions the tests import.                                                                  |

## Run

The suite calls the TypeSafe API and may incur a charge. From the repository
root, build once, then run from this folder:

```sh
corepack pnpm install && corepack pnpm build
cd examples/saucedemo
cp .env.example .env         # then set TYPESAFE_API_KEY
node ../../packages/cli/dist/cli.js run --headed
```

In your own project, the same tests run with `npx sedum run` after
`npm install -D sedum-cli @faker-js/faker`.

Run one file, the tests whose title contains a word, or one test by its id:

```sh
node ../../packages/cli/dist/cli.js run tests/cart.test.ts
node ../../packages/cli/dist/cli.js run --name "locked-out"
node ../../packages/cli/dist/cli.js run --id "tests/login.test.ts#a standard user signs in"
```

`node ../../packages/cli/dist/cli.js validate` checks every literal `ai(...)`
sentence without a browser.
