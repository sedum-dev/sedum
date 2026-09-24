# Plain-English browser tests

This page explains the basics: what an end-to-end test is, why they are hard to
keep working, and what changes when you write them in plain English and let a
model read the page.

## End-to-end tests

An end-to-end (e2e) test uses your app the way a person does. It opens a real
browser, clicks, types, and then checks what the page shows. Unit tests check
one function; an e2e test checks that the whole product works from the
outside: the frontend, the backend, and everything between them.

## How they are usually written

Most e2e tests are code, written with a tool such as Playwright or Cypress. The
test has to point at every element with a selector: a CSS class, an id, a
`data-testid`, or a text match.

```ts
await page.goto("https://www.saucedemo.com/");
await page.locator("#user-name").fill("standard_user");
await page.locator("#password").fill(process.env.SAUCE_PASSWORD!);
await page.locator("[data-test=login-button]").click();
await expect(page.locator(".inventory_item")).not.toHaveCount(0);
await expect(page.locator(".inventory_item_price").first()).toBeVisible();
```

This works, but it has three costs:

- **Selectors describe the markup, not the product.** Rename a class or move a
  button into a menu, and the test breaks even though a person could still
  sign in.
- **Assertions check structure, not meaning.** The test above checks that some
  elements with a price class exist. It cannot check "a list of products with
  prices is shown" as a person would read it.
- **Only engineers can read or change them.** Product managers and QA
  testers who know what should happen often cannot review what the test does.

Teams end up spending a large share of their testing time fixing tests that
broke for reasons that do not matter to users.

## Tests in plain English

A plain-English test says what a person would do and what they should see.
The same test in Sedum:

```yaml
url: https://www.saucedemo.com/
data:
  user: standard_user
  password: $SAUCE_PASSWORD
steps:
  - type {{user}} in the username field
  - type {{password}} in the password field
  - click the login button
  - verify a list of products with prices is shown
```

There are no selectors. Anyone who knows the product can read it, and it keeps
working when the markup changes, as long as the page still has a username
field and a login button.

## How an AI test runs

A plain-English test needs something to connect each sentence to the page.
That is the model's job. For every step, the runner:

1. **Reads the page.** It builds a description of what is visible: text,
   buttons, fields, and their labels.
2. **Finds the element.** For "click the login button", the model picks the
   element the sentence refers to, or says that none matches.
3. **Acts.** The browser clicks or types, as a coded test would.
4. **Checks claims.** For "verify a list of products with prices is shown",
   the model judges whether the claim holds on the page.

## The trade-offs

Reading the page with a model has real costs, and they are worth knowing
before you choose a tool.

- **Cost.** Every model call costs money. Tools that charge per step can make
  a suite too expensive to run on every pull request, so teams run it weekly
  and catch bugs late.
- **Speed.** A model call is slower than a CSS selector. A slow model on every
  step makes a long test much slower.
- **Uncertainty.** A model can be unsure, or wrong. A tool that turns every
  answer into a plain yes or no hides that, and the result looks like a flaky
  test with no explanation.

Tools also differ in how much they hand to the model. Some let an agent drive
the whole browser and decide every action. That is flexible, but each run can
take a different path, and it is hard to tell why a run failed.

## Where Sedum fits

Sedum keeps the model's job small. It uses a model for two things only:
finding the element a sentence refers to, and judging whether a claim holds.
Everything else is deterministic and runs on Playwright: clicking, typing,
waiting, verdicts, and exit codes.

The model is Jev, which is fast and cheap enough to ask on every step. That is
what makes it practical to run the whole suite on every pull request. And
instead of a plain yes or no, Jev returns probabilities, so Sedum can tell you
how sure each check is. See [probabilistic testing](probabilistic-testing.md).

To try it, follow [Get started](../README.md#get-started) in the README.
