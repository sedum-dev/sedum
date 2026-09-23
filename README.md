# Sedum

Write browser tests in plain English. Sedum runs them in a real browser.

```yaml
# tests/login.test.yaml
description: a customer signs in
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

```sh
sedum run tests/login.test.yaml
```

Sedum uses a model for two jobs only: finding the element a sentence refers to,
and judging whether a claim such as "a list of products with prices is shown"
holds on the page. The model returns probabilities, not free text. Everything
else is deterministic: clicking, typing, waiting, verdicts, and exit codes run
on Playwright.

> **Status: pre-alpha.** Sedum is working toward a 0.1 alpha. It is not on npm
> yet, the test format may change before 1.0, and Windows is experimental.
> Linux and macOS are verified.

## Get started

### 1. Install

You need Node.js 20.19 or newer. Until the first npm release, build Sedum from
source:

```sh
git clone https://github.com/sedum-dev/sedum.git
cd sedum
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
alias sedum="node $PWD/packages/cli/dist/cli.js"
```

### 2. Scaffold a project

In another directory, run `sedum init` to create a runnable SauceDemo example:

```sh
mkdir my-sedum-tests && cd my-sedum-tests
sedum init
```

The command keeps existing files and prints the next steps. In an interactive
color terminal, it shows the Sedum wordmark; redirected output stays plain.

### 3. Install a browser

The generated project selects Chromium. Install the matching browser if `init`
says it is missing:

```sh
sedum browsers install chromium
sedum browsers install chromium --with-deps   # Linux: also installs system dependencies
```

### 4. Add your model key

Sedum uses [TypeSafe](https://typesafe.ai) to find elements and judge claims.
Copy `.env.example` to `.env` if `.env` does not already exist, then put your
key there or in the environment. The example file also contains the public
SauceDemo password `secret_sauce`:

```sh
TYPESAFE_API_KEY=...
```

### 5. Check your setup

```sh
sedum doctor
```

`doctor` checks Node, your config, the browser, network access, the API key,
and the output directory. Every failed check says how to fix it.

### 6. Run the generated test

After setting `TYPESAFE_API_KEY`, run:

```sh
sedum run tests/example.test.yaml --headed
```

Try changing the last step to a false claim, such as `verify the cart is
empty`, and run again to see a failure.

## Writing tests

A test is a `*.test.yaml` file with a starting `url` and a list of `steps`.
Each step is one sentence that does one thing:

| You write                                        | Sedum does                        |
| ------------------------------------------------ | --------------------------------- |
| `click the Checkout button`                      | finds the button and clicks it    |
| `type {{postcode}} in the Zip/Postal Code field` | types a value from `data`         |
| `verify the order summary lists 2 items`         | judges the claim against the page |
| `remember the price shown as {{price}}`          | stores page text for a later step |

- **Data and secrets.** `{{name}}` refers to a `data` value. `$VAR` reads an
  environment variable when the test runs. Values that come from the
  environment are treated as secrets: they are hidden in reports and model
  requests.
- **Reuse.** Put shared steps, such as a login, in a `*.module.yaml` file and
  call it with `use:`. Add `before` and `after` steps for setup and cleanup.
- **Identity.** A test's path is its id. Add `id:` to keep it stable across
  renames, and `tags:` to group tests.

See the [test file format](docs/format.md) for the full reference.

## Reading results

Each test ends in a verdict:

| Exit | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| `0`  | Every test passed.                                                                              |
| `1`  | A test failed.                                                                                  |
| `2`  | Tests passed, but some claims were uncertain (only with `--strict`).                            |
| `3`  | Sedum could not reach a verdict: a missing browser, key, file, or config, or the run timed out. |

A pass can carry a flag. `low_confidence` means the claim was supported, but
only just. `contradiction` means the page also gave some evidence against it.
Flagged passes still exit `0`, so use `--strict` in CI if they should fail the
build.

When a step fails or is flagged, the output shows a **needs attention** block
with the sentence, its file and line, the reason, the model's scores, and a
command to rerun that test. The full result is saved to
`.sedum/runs/<run-id>/result.json`, with screenshots of failing steps.

```sh
sedum run --reporter steps      # show each step as it runs
sedum run --strict --costs      # fail on flags; always show token cost
sedum run --reporter json       # also write a final JSON copy under .sedum/reports
```

## Choosing what to run

`sedum run` with no paths runs the configured test directory. You can also name
files or directories, and filter what they contain:

```sh
sedum run tests/checkout                  # one directory
sedum run --labels smoke,auth             # tests tagged with both
sedum run --name checkout                 # id or description contains "checkout"
sedum run --include '**/*login*.test.yaml' --exclude 'tests/legacy/**'
```

Other useful options:

- `--retries <n>` reruns a failed test up to `n` times, each from a fresh
  browser and its `before` steps. Every attempt is kept in the result.
- `--timeout-minutes <m>` bounds the whole run. On timeout, partial results are
  saved and Sedum exits `3`.
- `--env <name>` selects a configured environment.
- `--url-override <url>` runs the same tests against another origin, such as a
  preview deploy, keeping each test's path.
- `--headed` shows the browser and highlights each element before it is
  clicked or filled. `--slow <ms>` slows it down.

## Configuration

Add a `sedum.config.yaml` at your project root to set defaults. Every key is
optional:

```yaml
tests:
  directory: tests
baseUrl: http://127.0.0.1:3000
environments:
  staging:
    baseUrl: https://staging.example.com
```

With a `baseUrl`, tests can use relative URLs. See
[project configuration](docs/configuration.md) for environments, variables,
thresholds, and `.env` rules.

## In CI

`sedum validate` needs no browser or key, so it can run on every commit. Once
Sedum is on npm:

```yaml
- run: npx sedum validate
```

Commit `.sedum/classifications.json` so validation works offline. To run tests
in CI, install a browser, set `TYPESAFE_API_KEY` as a secret, and run
`sedum run --strict`.

## Commands

| Command                  | Does                                           |
| ------------------------ | ---------------------------------------------- |
| `sedum run [paths]`      | Runs tests: the whole project, or named paths. |
| `sedum validate [paths]` | Checks tests and modules offline.              |
| `sedum list [paths]`     | Lists tests with their ids, tags, and paths.   |
| `sedum doctor`           | Checks that this machine can run Sedum.        |
| `sedum browsers install` | Installs Chromium.                             |
| `sedum cache`            | Manages the local locator cache.               |

Every command has `--help`. See [CLI commands](docs/cli.md) for details.

## Privacy and cost

Sedum sends the model the step's sentence and a bounded description of the
page: visible text, and the names and roles of elements. It does not send
cookies, raw HTML, hidden text, or the values in form fields. Secrets from the
environment are replaced by placeholders. Other visible page text is sent as
it is. Use `--sensitive-origin <url>` to keep a page's details and screenshots
out of saved results.

In a terminal, Sedum shows token use and cost after each run. A [local locator
cache](docs/locator-cache.md) skips repeat lookups during development. See the
[TypeSafe provider](docs/provider-typesafe.md) notes for exactly what is sent.

## Coming next

Planned for the 0.1 alpha:

- `sedum init` to scaffold a project
- parallel runs and sharding
- starting your app before a run
- JUnit, Markdown, and HTML reports
- a GitHub Action and an npm release

## More

- [Documentation](docs/README.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT licence](LICENSE)
