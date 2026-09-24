# Sedum

[![CI](https://github.com/sedum-dev/sedum/actions/workflows/ci.yml/badge.svg)](https://github.com/sedum-dev/sedum/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sedum-cli.svg)](https://www.npmjs.com/package/sedum-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)

Write browser tests in plain English, and run the whole suite on every pull
request for dollars a month instead of thousands.

<!-- demo: 15 s GIF of `sedum run --headed` passing, then a false claim failing -->

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
npx sedum run tests/login.test.yaml
```

Sedum uses a model for two jobs only: finding the element a sentence refers to,
and judging whether a claim such as "a list of products with prices is shown"
holds on the page. That model is [Jev](https://typesafe.ai), from TypeSafe. It
returns probabilities, not free text. Everything else is deterministic:
clicking, typing, waiting, verdicts, and exit codes run on Playwright.

> **Status: pre-alpha.** The first alpha is on npm as `sedum-cli`. The test
> format may change before 1.0, and Windows is experimental. Linux and macOS
> are verified.

## Quickstart

You need Node.js 20.19 or newer and a [TypeSafe](https://typesafe.ai) API key or a compatible provider key.

```sh
mkdir my-sedum-tests && cd my-sedum-tests
npm init -y
npm install -D sedum-cli
npx sedum init                        # an example test, config, and .env.example
npx sedum browsers install chromium   # if init says it is missing
cp .env.example .env                  # then set TYPESAFE_API_KEY in .env
npx sedum run tests/example.test.yaml --headed
```

For a compatible provider, set `TYPESAFE_BASE_URL` to its API root and
`TYPESAFE_API_KEY` to that provider's key. Set `TYPESAFE_DEFAULT_MODEL` if its
model name differs from the default. See
[provider configuration](docs/configuration.md).

The example signs in to a demo shop. To see a failure, change its last step to
a false claim, such as `verify the cart is empty`, and run it again. If
anything is missing, `npx sedum doctor` says what and how to fix it.

New to AI browser tests? Read
[plain-English browser tests](docs/plain-english-tests.md) first.

## Why Sedum

Writing tests in English is not new. Running them on every pull request is
usually too expensive, because hosted tools charge per step. Sedum is open
source, runs on your machine with your own key, and calls a model that is fast
and cheap enough to ask on every step.

|                                   | Per-step platform | Sedum on Jev           |
| --------------------------------- | ----------------- | ---------------------- |
| Monthly cost of a team's PR suite | $4,875            | $38–$91 (**53× less**) |
| 17-step checkout on saucedemo.com | 69 s              | 14 s (**4.9× faster**) |

The cost row is 50 tests of 10 steps (3 of them AI steps), run about 20 times a
day by a 20-person team, priced at a per-step platform's published
pay-as-you-go rates and at Jev's posted token price ($91 with the cache off).
The speed row is five runs each with every cache off, on one laptop. See
[sedum.dev](https://sedum.dev) for the full method.

How it compares with other ways to test in a browser:

|                         | Coded tests (Playwright, Cypress) | Browser agents      | Per-step AI platforms | Sedum |
| ----------------------- | --------------------------------- | ------------------- | --------------------- | ----- |
| Selectors to maintain   | Yes                               | No                  | No                    | No    |
| Same actions every run  | Yes                               | No, the agent picks | Yes                   | Yes   |
| Cost to run on every PR | Low                               | High                | High                  | Low   |
| Open source, your key   | Yes                               | Often               | No                    | Yes   |

- **Probabilities, not guesses.** Every claim is scored against a threshold you
  set, and checked for contradicting evidence. A marginal pass is flagged, not
  silently green. See [probabilistic testing](docs/probabilistic-testing.md).
- **No black box.** Prompts, scoring, and caching are in this repo. You can see
  exactly what goes to the model and what comes back.

## Fix failures with your coding agent

When a test fails, have Sedum write a report for an agent such as Claude Code
or Cursor:

```sh
npx sedum run --reporter markdown
# markdown .sedum/runs/<run-id>/report.md
```

Then ask the agent to read that file and fix the failure. The report puts the
most urgent problem first, with the sentence and its file and line, the scores,
the page text the model judged, the elements it considered, a screenshot, and a
command to rerun just that test, so the agent can check its own fix. Page text
is fenced and labelled untrusted, so a page cannot inject instructions into the
report.

## Writing tests

A test is a `*.test.yaml` file with a starting `url` and a list of `steps`.
Each step is one sentence that does one thing:

| You write                                        | Sedum does                        |
| ------------------------------------------------ | --------------------------------- |
| `click the Checkout button`                      | finds the button and clicks it    |
| `type {{postcode}} in the Zip/Postal Code field` | types a value from `data`         |
| `verify the order summary lists 2 items`         | judges the claim against the page |
| `remember the price shown as {{price}}`          | stores page text for a later step |

`{{name}}` refers to a `data` value, and `$VAR` reads an environment variable.
Values from the environment are treated as secrets and hidden from reports and
model requests. Put shared steps, such as a login, in a `*.module.yaml` file
and call it with `use:`.

## Learn more

- [Test file format](docs/format.md): data, secrets, modules, `before` and
  `after` steps, ids, and tags.
- [CLI commands](docs/cli.md): filters, parallel runs and sharding, retries,
  timeouts, reporters, and exit codes.
- [Running in CI](docs/ci.md): GitHub Actions, GitLab, and Jenkins, with JUnit
  and job summaries.
- [Project configuration](docs/configuration.md): `sedum.config.yaml`,
  environments, thresholds, and `.env`.
- [Probabilistic testing](docs/probabilistic-testing.md): how scores become
  verdicts, flags, and exit codes.
- [Privacy](docs/provider-typesafe.md): exactly what is sent to the model, and
  what never is.
- [All documentation](docs/README.md)

## Coming next

Recently shipped: the first alpha on npm, `sedum init` to scaffold a project,
parallel runs and sharding, and JUnit reports.

Planned for the 0.1 alpha:

- a GitHub Action
- starting your app before a run

Coming soon after that:

- **Goal-based tests.** State the outcome and let Sedum work out the steps:

  ```yaml
  url: https://shop.example.com/
  goal: >
    sign in, add a hat to the cart, check out with the saved card
  verify: the confirmation page shows an order number
  ```

  Until then, write each step as a sentence.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
to build from source, and [SECURITY.md](SECURITY.md) to report a
vulnerability. Sedum is [MIT licensed](LICENSE).
