# sedum-cli

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [175e84c]
- Updated dependencies [be6d287]
  - @sedum-dev/core@0.1.0-alpha.12
  - @sedum-dev/provider-clef@0.1.0-alpha.12
  - @sedum-dev/provider-typesafe@0.1.0-alpha.12
  - @sedum-dev/reporters@0.1.0-alpha.12

## 0.1.0-alpha.11

### Minor Changes

- 2252c19: Harden experimental affected-test selection for large monorepos. Pin committed
  Git inputs, refuse dirty tracked files and index flags that can hide local edits,
  and add additive `affected.ignore` and repeatable `--affected-ignore` path filters.
  Changed tests and module dependents remain selected even when ignored.

  Score retained diffs with lossless, preflighted file/hunk/line/Unicode chunks in
  both providers, preserve complete candidate test/module sources, and aggregate
  relevance with the maximum score across chunks. Enforce explicit retained-diff
  and request-count guards, preserve all receipts, and fail on incomplete scoring.
  Raise the default threshold from 0.1 to 0.3; pass `--threshold 0.1` to retain the
  previous cutoff. Selection remains experimental and live relevance accuracy
  remains unverified.

### Patch Changes

- Updated dependencies [2252c19]
  - @sedum-dev/core@0.1.0-alpha.11
  - @sedum-dev/provider-typesafe@0.1.0-alpha.11
  - @sedum-dev/provider-clef@0.1.0-alpha.11
  - @sedum-dev/reporters@0.1.0-alpha.11

## 0.1.0-alpha.10

### Patch Changes

- 3d3a585: Add a package README, description, keywords, license, and homepage so the npm page explains what Sedum is and how to try it.
  - @sedum-dev/core@0.1.0-alpha.10
  - @sedum-dev/reporters@0.1.0-alpha.10
  - @sedum-dev/provider-typesafe@0.1.0-alpha.10
  - @sedum-dev/provider-clef@0.1.0-alpha.10

## 0.1.0-alpha.9

### Patch Changes

- 9640bbb: Validate literal `ai.holds` claims offline without requiring a classification cache, while preserving errors and incomplete validation for malformed, dynamic, action, and wait forms.
- c4ea782: Accept `CLOUDFLARE_API_TOKEN` as an alias for Clef while preserving
  `CLOUDFLARE_AUTH_TOKEN`, rejecting ambiguous same-level values, and keeping
  both secrets out of test variables. Make run, affected-selection, validation,
  and doctor failures name Cloudflare account access and Workers AI permissions
  instead of incorrectly recommending `TYPESAFE_API_KEY`.
- Updated dependencies [9640bbb]
- Updated dependencies [af96cef]
- Updated dependencies [388a60b]
- Updated dependencies [bdcf5bd]
  - @sedum-dev/core@0.1.0-alpha.9
  - @sedum-dev/provider-clef@0.1.0-alpha.9
  - @sedum-dev/provider-typesafe@0.1.0-alpha.9
  - @sedum-dev/reporters@0.1.0-alpha.9

## 0.1.0-alpha.8

### Minor Changes

- 89cbfc8: Add Cloudflare Clef and Clef-flash as opt-in text decision providers while
  keeping TypeSafe as the default. Include provider-aware classification caches,
  provider identity in compatible receipts, fixed Cloudflare routing, CLI and
  doctor integration, bounded retries, and all six text decision operations.
- 947e960: Add `ai.goal(goal, values?, options?)` to TypeScript tests for bounded planner-driven
  click and type execution. Accepted planner completion resolves without hidden
  independent verification; semantic `ai("verify ...")` steps and Playwright
  assertions remain separately authored. Report planner completion explicitly,
  support per-invocation automatic Faker data, and prevent automatic whole-test
  retries after a goal enters planning. Set `options.generateData: false` to disable
  automatic generation for one goal and use only supplied or remembered values.

### Patch Changes

- Updated dependencies [89cbfc8]
- Updated dependencies [947e960]
  - @sedum-dev/core@0.1.0-alpha.8
  - @sedum-dev/reporters@0.1.0-alpha.8
  - @sedum-dev/provider-typesafe@0.1.0-alpha.8
  - @sedum-dev/provider-clef@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- 4985099: Branch on what the page shows. `await ai.holds("the passkey screen is shown")` judges a claim like a verify and returns `true` or `false`; it never fails the test and is recorded without a verdict. Use it for screens that appear only sometimes, such as an optional prompt, instead of reading the URL or the DOM in code.
- 757f45f: Wait for the page the way a person does. `wait until the reply is shown` (or `wait up to 90 seconds until …`, 30 seconds by default, at most 120) judges its claim again each time the page changes and passes as soon as it holds, through slow server responses and redirects. The CLI also gives a failing `verify`, and a click or type whose target is not on the page yet, a 5-second grace like Playwright's auto-wait: the step is judged or located again only when the page changes, so a page that stays put costs no extra model calls. Set `SEDUM_VERIFY_GRACE_MS=0` to judge once.
- Updated dependencies [4985099]
- Updated dependencies [db3272b]
- Updated dependencies [9a94894]
- Updated dependencies [9e2bec1]
- Updated dependencies [16e7c00]
- Updated dependencies [245261c]
- Updated dependencies [757f45f]
  - @sedum-dev/core@0.1.0-alpha.7
  - @sedum-dev/provider-typesafe@0.1.0-alpha.7
  - @sedum-dev/reporters@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- 86efefd: Report vision fallback attempts and their selected, abstained, or failed outcomes separately. Do not claim every click resolved from page text when vision was not attempted; call out failed clicks without vision instead.
- 78911d8: Include node_modules/ in init's ignore rules so a new project's first git add does not stage installed dependencies.
- Updated dependencies [8dd5d42]
- Updated dependencies [892c784]
  - @sedum-dev/core@0.1.0-alpha.6
  - @sedum-dev/reporters@0.1.0-alpha.6
  - @sedum-dev/provider-typesafe@0.1.0-alpha.6

## 0.1.0-alpha.5

### Minor Changes

- fd55a18: Write tests in TypeScript. A `*.test.ts` file declares tests with `test(title, options, async ({ page, context, ai, env, testInfo }) => { ... })`. Plain-English steps run with `await ai("click the Login button")`; values go in a second argument (`ai("type {{email}} into the Email field", { email })`) and `secret()` keeps a value out of model input and reports. `ai.group` names a block of steps, `ai.extract` reads an element's text, and Playwright's `page`, `context`, and `expect` work between steps. `sedum run`, `list`, and `validate` discover `*.test.ts` beside `*.test.yaml`; `validate` classifies the literal sentences in `ai(...)` calls and warns about sentences built at run time. `sedum run --id <id>` selects tests by exact id, and reports name a TypeScript test by its file and title and rerun it with `--id`. `sedum init` now writes a TypeScript example.

### Patch Changes

- 9131d3c: Report `cache miss (not_cacheable)` for a target the locator cache never stores, such as an `<input type="submit">` button, instead of `cache miss (absent)`, which implied the next run would hit. A run outside a Git checkout now prints a hint to run `git init` to enable the cache, and the README Quickstart includes `git init`.
- 834b723: Keep running the rest of the suite when one test cannot run. Previously the first test-scoped error, such as an unsupported step, stopped `sedum run` and the remaining selected tests never ran. That test is now recorded with `state: "error"`, and every other test still gets a verdict. The run still exits 3, and the summary says how many tests could not run. A missing browser, a rejected provider key, or sustained rate limiting still stops the run immediately.

  A rejected provider key is now reported as `provider_authentication` and stops the run at the first request, instead of surfacing as `Could not resolve this click step` in every test.

- c5469e4: Clearer error messages:

  - An unreachable test URL now reports `navigation_failed` with the cause, e.g. "Could not open the test's page: the host name could not be resolved (DNS)", instead of "The browser run could not be completed safely".
  - A missing test path is named in the final error instead of blaming `sedum.config.yaml`'s `tests.include`.
  - A misspelt key in `sedum.config.yaml` gets a "Did you mean `browser`?" fix, as test files already do.
  - A run that never started a test no longer prints "read …" hints.
  - An unresolved step says why (no element matches, several match, or nothing to click), and its error code is `no_match` instead of `none`.
  - `report.md` labels an error "browser error, untrusted" only when it came from the browser.
  - A test file with neither `steps` nor `goal` is told so, instead of "…but not both".
  - An unexpected internal error is no longer reported as "The command could not be parsed safely".

- 0ddfcad: Flag a test that passes only after a failed attempt as `flaky`. It still counts as passed, but the flag appears on the test, in the run's flags, in the terminal summary (`flaky N test(s)`) and in JUnit output, and `--strict` exits 2 as for any flagged pass. Previously `--retries` could hide a flaky test completely.
- 45e4f4e: Print `npx sedum …` in hints when sedum runs from a project's `node_modules` or through npx, as the README installs it. Previously every "Next steps", "rerun" and "Fix" hint said bare `sedum …`, which fails with "command not found" for a local install. This covers terminal output and the rerun hints in the HTML, Markdown and JUnit reports. A global install keeps `sedum`.
- 0662f50: Say that the model provider rejected the API key when a run uses a wrong `TYPESAFE_API_KEY`, as `sedum doctor` does, and point to `TYPESAFE_API_KEY` and `sedum doctor` in the fix. The step that hit the rejection is recorded with the `provider_authentication` error. Previously the run reported a vague provider failure, and before that an unresolved click with test-input advice.
- 77f0e94: Stop repeating lines in `sedum run` terminal output. Each test's result line appeared twice, the `progress` path twice, and the cost three ways ("Text models", "All models (all attempts)", and "model … / cost …"). The final summary now adds only per-test details (retries and cache outcomes) under the test's file, names `progress.json` once at the start, and shows one cost breakdown. "All models" appears only when vision calls make it differ from "Text models", and an incomplete cost is still called out.
- 2fbd519: Fix vision fallback never running when the page was still settling after a navigation. The screenshot's freshness check failed, and the error was swallowed as an ambiguous target. That case is now reported as stale, so the runner takes its one fresh observation and vision gets its turn.

  Make vision's behavior visible. With vision enabled, `sedum run` checks `OPEN_ROUTER_API_KEY` against OpenRouter's unbilled key endpoint before tests start and warns in the summary when the key is rejected. The summary says how many steps used vision, or that vision was not needed. A click that fails without trying vision explains why. `sedum doctor` checks the vision key when vision is enabled, or with `--vision`.

  Vision fallback now also runs when the text model finds no matching element for a click, for example a target described by its picture. Vision chooses among every visible control or abstains; an abstention keeps the step unresolved as before.

- Updated dependencies [9131d3c]
- Updated dependencies [834b723]
- Updated dependencies [a8f641d]
- Updated dependencies [c5469e4]
- Updated dependencies [0ddfcad]
- Updated dependencies [c135228]
- Updated dependencies [e83c74c]
- Updated dependencies [45e4f4e]
- Updated dependencies [0662f50]
- Updated dependencies [cbd82f1]
- Updated dependencies [acae6ef]
- Updated dependencies [4ba7bfd]
- Updated dependencies [3df6e4a]
- Updated dependencies [62db939]
- Updated dependencies [77f0e94]
- Updated dependencies [fd55a18]
- Updated dependencies [2fbd519]
  - @sedum-dev/core@0.1.0-alpha.5
  - @sedum-dev/reporters@0.1.0-alpha.5
  - @sedum-dev/provider-typesafe@0.1.0-alpha.5

## 0.1.0-alpha.4

### Minor Changes

- 2300463: Add opt-in OpenRouter vision fallback for ambiguous repeated-control clicks,
  with CLI/configuration support, labeled screenshots, validated candidate
  selection, and safe request diagnostics. Existing Jev caching is unchanged;
  vision selections are not cached.

  Show vision fallback outcomes, models, and duration in HTML, Markdown, and CLI
  reports, with separate text/vision token and cost summaries across all attempts.
  Distinguish provider-reported vision cost from unavailable per-token pricing and
  preserve known subtotals when some calls have unknown costs.

- 20ae8f2: Support YAML goal tests with required independent verification, supplied data,
  authored setup/teardown hooks, bounded execution and per-action reporting with
  opt-in replay frames and planner usage.
  Show complete, secret-redacted Goal and Verify context above the HTML replay
  and action list without changing authored-step report layouts.
  Do not automatically retry failed goal tests.

### Patch Changes

- Updated dependencies [2300463]
- Updated dependencies [20ae8f2]
  - @sedum-dev/core@0.1.0-alpha.4
  - @sedum-dev/reporters@0.1.0-alpha.4
  - @sedum-dev/provider-typesafe@0.1.0-alpha.4

## 0.1.0-alpha.3

### Minor Changes

- 4b50aa6: Add experimental `sedum run --affected` selection using one Jev relevance probability per test against a Git merge-base diff. Include a JSON preview, configurable base and threshold, complete module context, and explicit failure handling without silently skipping tests.

### Patch Changes

- Updated dependencies [027b095]
- Updated dependencies [4b50aa6]
- Updated dependencies [3e2d8a6]
  - @sedum-dev/core@0.1.0-alpha.3
  - @sedum-dev/provider-typesafe@0.1.0-alpha.3
  - @sedum-dev/reporters@0.1.0-alpha.3

## 0.1.0-alpha.2

### Minor Changes

- 978f16e: Allow Sedum to use TypeSafe System One-compatible services through the
  `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, and `TYPESAFE_API_KEY`
  environment variables, matching the TypeSafe SDK.

### Patch Changes

- Updated dependencies [978f16e]
  - @sedum-dev/provider-typesafe@0.1.0-alpha.2
  - @sedum-dev/core@0.1.0-alpha.2
  - @sedum-dev/reporters@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Updated dependencies [99bd8ea]
  - @sedum-dev/core@0.1.0-alpha.1
  - @sedum-dev/provider-typesafe@0.1.0-alpha.1
  - @sedum-dev/reporters@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- ea32dc3: Add `--reporter markdown`, which writes `report.md` for coding agents beside `result.json`. The report puts the most urgent failure first and gives its evidence and a rerun command. Frames now live in a new directory for each attempt, so concurrent runs and retries never overwrite or delete each other's evidence. The HTML and markdown reports share one sort order (failed, incomplete, flagged, passed) and print a score with extra digits whenever two decimals would misstate its comparison with a decision line.
- 2519035: Add `--reporter junit`, which writes `<reporterDir>/<run-id>/junit.xml` for CI test views. A flagged pass stays a passing testcase with its flags as metadata, and `--strict` adds a failure, so the file always matches the exit code. Failures carry the step, source position, scores, browser error and a rerun command. Evidence frames are attached with `[[ATTACHMENT|path]]`, relative to the CI checkout when GitLab, Jenkins or GitHub Actions is running. `--reporter` now also takes a comma-separated list such as `junit,markdown`. `@sedum-dev/reporters` exports `renderJunit`, `isEvidenceDirectory` and `runIsTrustworthy`, which the CLI's exit code now uses.
- b3e2ca2: Add `sedum run --parallel <n|auto>` to run tests in parallel lanes and `--shard-index`/`--shard-count` to split a suite across CI jobs deterministically. Each lane keeps one browser, and every attempt gets a fresh context plus its own `SEDUM_ATTEMPT_KEY`. Results stay in selection order. Model-provider requests share one concurrency cap (`--provider-concurrency`), and all lanes pause together for one 429 cooldown that honors `Retry-After`. A 429 no longer uses up a call's retry attempts; a call rate limited for five minutes ends the run with `provider_rate_limited`. Terminal output prints one block per test when lanes interleave. Locator cache write races are reported as `conflict`, and stale locks are recovered.
- bb4fa38: Prepare the first public npm alpha with Changesets versioning, reproducible candidate tarballs, provenance, three-platform package installation checks, and human-approved publication of the verified tarballs.
- 9bcc324: Create a branded, self-contained HTML report for every run, with optional embedded replay frames and a RunResult-based cost receipt.

### Patch Changes

- Updated dependencies [ea32dc3]
- Updated dependencies [2519035]
- Updated dependencies [b3e2ca2]
- Updated dependencies [b3e2ca2]
- Updated dependencies [bb4fa38]
- Updated dependencies [9bcc324]
  - @sedum-dev/core@0.1.0-alpha.0
  - @sedum-dev/reporters@0.1.0-alpha.0
  - @sedum-dev/provider-typesafe@0.1.0-alpha.0
