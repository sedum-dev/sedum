# TypeScript tests

A `*.test.ts` file holds one or more tests. Each test is an async function:
plain-English steps run through `ai`, and anything else is ordinary
TypeScript: Playwright calls on `page`, `expect` assertions, API requests,
test data from any library, loops, and helper functions.

```ts
// tests/checkout.test.ts
import { faker } from "@faker-js/faker";
import { test, expect, secret } from "sedum-cli";

test(
  "a new customer checks out",
  { url: "/", tags: ["checkout"] },
  async ({ page, ai, env }) => {
    await ai.group(
      "Log in",
      [
        "type {{user}} in the username field",
        "type {{password}} in the password field",
        "click the login button",
      ],
      { user: "standard_user", password: secret(env.SAUCE_PASSWORD!) },
    );

    await ai("click the Add to cart button for {{product}}", {
      product: "Sauce Labs Backpack",
    });
    await expect(page.locator(".shopping_cart_badge")).toHaveText("1");

    await ai("click the shopping cart link");
    await ai("click the Checkout button");
    await ai("type {{first}} in the First Name field", {
      first: faker.person.firstName(),
    });
    await ai("type {{last}} in the Last Name field", {
      last: faker.person.lastName(),
    });
    await ai("type {{zip}} in the Zip/Postal Code field", {
      zip: faker.location.zipCode(),
    });
    await ai("click the Continue button");

    const total = await ai.extract("the order total");
    expect(total).toContain("$");
    await ai("click the Finish button");
    await ai("verify the order was placed and a confirmation message is shown");
  },
);
```

```sh
npx sedum run                                  # every test under tests/
npx sedum run tests/checkout.test.ts           # every test in one file
npx sedum run --id "tests/checkout.test.ts#a new customer checks out"   # one test
```

Install `sedum-cli` in the project (`npm install -D sedum-cli`) so your editor
has its types. Sedum compiles the file itself with
[jiti](https://github.com/unjs/jiti); you need no build step or `tsconfig.json`
to run tests. Types are not checked at run time; run `tsc --noEmit` for that.

## Declaring tests

```ts
test(title, body);
test(title, options, body);
```

| Option | Meaning                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------- |
| `url`  | Entry URL, absolute or relative to `baseUrl`. Omitted: `baseUrl`, or a blank page without one.          |
| `id`   | Stable identity. Default: `<file>#<title>`, such as `tests/checkout.test.ts#a new customer checks out`. |
| `tags` | Labels for `sedum run --labels`.                                                                        |

Titles must be unique within a file and ids unique in the project. Each test
gets a fresh browser context and runs on its own, in parallel lanes and with
`--retries` like a YAML test. Top-level code in the file runs once when Sedum
imports it, so keep per-test setup inside the body.

The body receives:

| Name       | What it is                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `ai`       | Runs plain-English steps; see below.                                                                            |
| `page`     | The Playwright [`Page`](https://playwright.dev/docs/api/class-page) the steps run on.                           |
| `context`  | Its [`BrowserContext`](https://playwright.dev/docs/api/class-browsercontext), for cookies, storage, and routes. |
| `env`      | Configured `variables`, the project `.env`, and the process environment, as `sedum run` resolves them.          |
| `testInfo` | `{ id, title, file, tags, attempt }`.                                                                           |

`expect` is Playwright's, with its auto-retrying matchers such as
`toHaveText` and `toHaveURL`, and the usual `toBe` and `toEqual`.

## Steps with `ai`

```ts
await ai("click the login button");
await ai("type {{email}} into the Email field", { email });
await ai(["click the Cart link", "click the Checkout button"]);
```

A sentence is one step, written exactly as in a YAML test and classified and
resolved the same way: `click`, `type`, `press`, `goto`, `scroll`, `wait`,
`verify`, `measure`, and `remember` (see
[step classification](classification.md)). A list runs its sentences in order,
sharing one values object.

**Pass values separately, not with `${}`.** Write `{{name}}` in the sentence
and give the value in the second argument. The sentence text stays the same on
every run, so its classification is cached and reused, and `sedum validate` can
check it before a run. A sentence built with `${}` or `+` is classified again
for every distinct value, and `validate` warns about it.

Values can be strings, numbers, and booleans. Before Sedum locates a target or
judges a claim, it puts plain values into the sentence, so
`click the Add to cart button for {{product}}` is resolved as the named
product. The value of a `type` step is typed, never shown to the model.

**Secrets.** Wrap a sensitive value in `secret()`. It is typed into the page,
but it stays a `{{placeholder}}` in model requests and is redacted from report
text and `result.json`. Printing a secret shows `[secret]`. Sedum learns a
secret when a step first passes it, so page text judged by an earlier step can
still contain it; screenshots are never redacted. List origins that show
secrets with `--sensitive-origin`.

```ts
await ai("type {{password}} into the Password field", {
  password: secret(env.SHOP_PASSWORD!),
});
```

`remember <target> as {{name}}` stores page text for later steps in the same
test, as in YAML.

**Always `await`.** Steps run one at a time on one page. A step started while
another is still running stops the test with an error that names the line.

## Groups

`ai.group` names a block of steps. Every step inside it is reported under the
name, such as `Checkout › click the Continue button`, and a failure names the
group it happened in. Groups can nest.

```ts
await ai.group(
  "Log in",
  ["type {{user}} in the username field", "click the login button"],
  { user },
);

await ai.group("Checkout", async () => {
  await ai("click the Checkout button");
  await page.getByLabel("First Name").fill(first); // code runs inside a group too
  await ai("click the Continue button");
});
```

## Reading from the page

`ai.extract(description)` returns the text of the element the description
names, found the same way as a `remember` target. Pass a parser, such as a zod
schema, to convert it:

```ts
const text = await ai.extract("the order total"); // "Total: $32.39"
const total = await ai.extract("the order total", {
  parse: (value) => Number(String(value).replace(/[^0-9.]/g, "")),
});
```

Extracted text is treated as page data: it is redacted from reports, like a
remembered value.

## Code between steps

Anything Playwright or Node can do works between steps. Use it where a
sentence is the wrong tool:

- **Skip slow setup.** Sign in through an API, or set a session cookie with
  `context.addCookies`, then `page.goto` the page under test.
- **Seed and inspect state.** Call your backend, or read `localStorage` with
  `page.evaluate`, and check it with `expect`.
- **Exact checks.** A count, a URL, or an element that must be absent is often
  clearer as a locator assertion than as a claim, for example
  `await expect(page.locator(".cart_item")).toHaveCount(0)`.
- **Generate data.** Use any library, such as `@faker-js/faker`, and pass the
  values to `ai`.
- **Share steps.** A module is a function: `export async function login(ai, user) { ... }`.
  A helper can also wrap `test()` itself, for example to add shared tags; the
  test belongs to the file that calls the helper.

The page settles before each `ai` step, so a step after code sees the page
that code left.

## Results

- **A failed step stops the test.** A failed `verify`, or a target that cannot
  be found, is recorded as a failed step, and the rest of the body does not
  run. The test fails even if your code catches the error.
- **An exception from your code fails the test.** A failed `expect` or any
  thrown error is recorded as a failed step with `operation: "code"`, at the
  file and line that threw, under its group. This includes a promise the test
  never awaits, such as an unawaited `page.click` or `expect`, and an
  `ai.group` or `ai.extract` whose code throws while nobody awaits it. To let a
  block fail on purpose, handle it: `await ai.group(...).catch(() => {})`.
- **Misusing `ai` is an invalid test.** A missing value, an invalid values
  object, or a missing `await` stops the run as an invalid test, like a YAML
  file with an error, with the file, line, and a fix.

Reports name a TypeScript test by its file and title, and rerun commands add
`--id` to select just that test.

## Validation and listing

`sedum list` imports each `*.test.ts` file and lists one row per `test()`.
`sedum validate` also finds the sentences passed to `ai(...)`, `ai([...])`,
and `ai.group(name, [...])`, in the test file and in the local modules it
imports, and checks them offline, or online with `--online`, exactly like YAML
steps. A list or sentence held in a `const` in the same file is read too, when
the file declares that name once and never reassigns it.
Validation recognizes the `ai` name.

An argument validation cannot read, such as a variable, a function call, or a
sentence built with `${}`, is reported as a warning. `validate` then does not
call the project fully valid, and exits 1, just as for a YAML sentence it could
not check offline.

Importing a file runs its top-level code. Keep network calls and other side
effects inside test bodies.

## Limits

- There are no `beforeEach` or `afterEach` hooks yet; use a helper function
  and `try`/`finally` for cleanup.
- `import ... from "sedum-cli"` always resolves to the CLI that runs the test,
  whichever version is installed in the project.
- A `*.test.ts` file cannot use YAML modules, and a YAML test cannot call
  TypeScript.
