# @sedum-dev/core

## 0.1.0-alpha.9

### Patch Changes

- 9640bbb: Validate literal `ai.holds` claims offline without requiring a classification cache, while preserving errors and incomplete validation for malformed, dynamic, action, and wait forms.
- af96cef: Discover and click controls that a CSS hover rule reveals from `display: none`. Hover discovery remains side-effect free, permanently hidden and inert controls stay excluded, and the browser driver hovers the exact snapshot host before revalidating and clicking the exact target.
- 388a60b: Re-observe goal pages when a target becomes stale before dispatch, while preserving exact target freshness, generated-value privacy, and no-replay guarantees. Stale and blocked goal reports now include actionable safe page, target, frame, and Faker-generator context without exposing generated values.
- bdcf5bd: Validate literal goal placeholders against statically readable inline and same-file const values objects.

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

## 0.1.0-alpha.7

### Patch Changes

- 4985099: Branch on what the page shows. `await ai.holds("the passkey screen is shown")` judges a claim like a verify and returns `true` or `false`; it never fails the test and is recorded without a verdict. Use it for screens that appear only sometimes, such as an optional prompt, instead of reading the URL or the DOM in code.
- db3272b: Click rows and the actions buttons that appear when a row is hovered. A clickable row (a pointer-cursor element) is now a target even when it holds icon-only controls, such as a list row with an actions menu, so `click the Alpha report row` works. A control that a stylesheet `:hover` rule reveals is offered too; Sedum rests the pointer on its row before clicking it, so `click the actions button on the Alpha report row` works. A control's name no longer includes the text or icons of a closed menu nested inside it, an icon button's context is bounded to its own row, and the button's hint lists what its menu offers.
- 9a94894: Check a control's state in a sentence. `verify the Save button is disabled` (or `enabled`), `verify the Email field contains {{email}}`, `verify the Search field is shown`, `is focused`, `is empty`, and `verify the Select all checkbox is checked` locate the control the way a click or type step does and read its state directly; page text carries no control state. A field's value is compared in the runner and never sent to the model, and password fields are never read.
- 9e2bec1: Check exact text without the Judge. Quoted text asks for an exact check on the page's visible text: `verify the text "Total" is not shown`, `verify "Add debt" appears once`, `verify "{{name}}" appears exactly 2 times`, `verify the text "A" or "B" is shown`, and `verify the page URL contains "/sign-up"`. Unquoted `the text X is shown` passes at once when X is on the page, in any letter case, and otherwise goes to the Judge as before, since the author may paraphrase. These checks read text the same way the Judge does, with no 4,096-character limit.
- 16e7c00: Navigate by path and through the browser history. `goto /practice/clients/{{id}}` opens a path on the site the test is on, so a test needs no full address for each environment. `go back`, `go forward`, and `reload the page` move through the page's history as the browser's buttons do.
- 245261c: Find fields by the caption beside or above them. A field with no label, named only by an example value such as `AB0A 0AA` or `E.g. 10,000`, now carries that caption as a hint, so `type SW1A 1AA in the Postal code field` finds it.
- 757f45f: Wait for the page the way a person does. `wait until the reply is shown` (or `wait up to 90 seconds until …`, 30 seconds by default, at most 120) judges its claim again each time the page changes and passes as soon as it holds, through slow server responses and redirects. The CLI also gives a failing `verify`, and a click or type whose target is not on the page yet, a 5-second grace like Playwright's auto-wait: the step is judged or located again only when the page changes, so a page that stays put costs no extra model calls. Set `SEDUM_VERIFY_GRACE_MS=0` to judge once.

## 0.1.0-alpha.6

### Patch Changes

- 8dd5d42: Keep extracted text associated with its own repeated product card instead of another card's title. Retry a stale final text read once with a fresh resolution, retaining strict freshness checks and model-call accounting. Describe TypeScript extract failures as extract targets rather than internal remember targets.
- 892c784: Wait for a bounded quiet page before capturing a vision fallback and re-observe stale captures before making the single model request. Keep post-request stale-page rejection fail-closed, report it explicitly, and preserve vision abstention reasons separately from the fallback trigger.

## 0.1.0-alpha.5

### Minor Changes

- fd55a18: Write tests in TypeScript. A `*.test.ts` file declares tests with `test(title, options, async ({ page, context, ai, env, testInfo }) => { ... })`. Plain-English steps run with `await ai("click the Login button")`; values go in a second argument (`ai("type {{email}} into the Email field", { email })`) and `secret()` keeps a value out of model input and reports. `ai.group` names a block of steps, `ai.extract` reads an element's text, and Playwright's `page`, `context`, and `expect` work between steps. `sedum run`, `list`, and `validate` discover `*.test.ts` beside `*.test.yaml`; `validate` classifies the literal sentences in `ai(...)` calls and warns about sentences built at run time. `sedum run --id <id>` selects tests by exact id, and reports name a TypeScript test by its file and title and rerun it with `--id`. `sedum init` now writes a TypeScript example.

### Patch Changes

- 9131d3c: Report `cache miss (not_cacheable)` for a target the locator cache never stores, such as an `<input type="submit">` button, instead of `cache miss (absent)`, which implied the next run would hit. A run outside a Git checkout now prints a hint to run `git init` to enable the cache, and the README Quickstart includes `git init`.
- 834b723: Keep running the rest of the suite when one test cannot run. Previously the first test-scoped error, such as an unsupported step, stopped `sedum run` and the remaining selected tests never ran. That test is now recorded with `state: "error"`, and every other test still gets a verdict. The run still exits 3, and the summary says how many tests could not run. A missing browser, a rejected provider key, or sustained rate limiting still stops the run immediately.

  A rejected provider key is now reported as `provider_authentication` and stops the run at the first request, instead of surfacing as `Could not resolve this click step` in every test.

- a8f641d: Name bare counts on icon controls in the page text the judge reads. The "1" on a cart icon used to appear as a lone `1` ("Swag Labs 1 Products"), so `verify the shopping cart badge shows 1` failed although the badge showed 1. It now appears as `cart icon badge: 1` when the control shows only the count and its class, id or test hook names a known icon kind. The docs explain which visual states the judge can and cannot see.
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
- c135228: Make the documented Sauce Demo goal example pass, and explain goal abstentions. The planner split its probability between the next step and `BLOCKED` (for example TYPE 0.50 vs BLOCKED 0.48 on the login page), so the goal abstained before acting or before placing the order. `BLOCKED` now means that no offered element can move the goal forward, and every step the goal names counts as expected. A goal action whose target went stale before dispatch is now taken back and the page observed again, instead of failing the goal. A goal that abstains reports which decision was uncertain, on which page, and its top probabilities, with a hint on how to rewrite the goal.
- e83c74c: Choose options in native `<select>` dropdowns. A click resolved to a native dropdown used to click the control, which changes nothing, and still report the step as passed. Now `click the "Price (low to high)" option in the sort dropdown` and `select "Price (low to high)" in the sort dropdown` choose that option. A click on a native dropdown that names no option fails and lists the options instead of passing silently. Quoted `select`, `choose`, and `pick` sentences classify offline without a model call.
- 0662f50: Say that the model provider rejected the API key when a run uses a wrong `TYPESAFE_API_KEY`, as `sedum doctor` does, and point to `TYPESAFE_API_KEY` and `sedum doctor` in the fix. The step that hit the rejection is recorded with the `provider_authentication` error. Previously the run reported a vague provider failure, and before that an unresolved click with test-input advice.
- cbd82f1: Fix `remember` failing with `stale: The remember target could not be resolved.` when the page was still settling after a navigation, for example a login redirect that rewrites its URL or fills in content. A `remember` step now gets the same single fresh observation after a stale resolution, and the same wait for an empty page to fill, that `click` and `type` steps already had.
- acae6ef: Stop redacting remembered page values in reports. `remember the price … as {{price}}` treated the price as a secret, so every later occurrence of `$ 29.99` in a failed step's excerpt read `[REDACTED]`, and a short value such as `1` blanked every matching substring. A remembered value is now redacted only when it was read on a sensitive origin or contains an environment-derived secret.
- 62db939: Run the documented `goto`, `press`, `scroll`, `wait` and `measure` steps. `sedum validate` accepted these verbs, but `sedum run` stopped on them with `unsupported_operation` and exit 3. Keys use Playwright names (`press enter` and `press the Esc key` both work), scrolls move about one screen, a `goto` address may contain `{{name}}` values, and `measure` records the judge's scores without gating the test.
- 2fbd519: Fix vision fallback never running when the page was still settling after a navigation. The screenshot's freshness check failed, and the error was swallowed as an ambiguous target. That case is now reported as stale, so the runner takes its one fresh observation and vision gets its turn.

  Make vision's behavior visible. With vision enabled, `sedum run` checks `OPEN_ROUTER_API_KEY` against OpenRouter's unbilled key endpoint before tests start and warns in the summary when the key is rejected. The summary says how many steps used vision, or that vision was not needed. A click that fails without trying vision explains why. `sedum doctor` checks the vision key when vision is enabled, or with `--vision`.

  Vision fallback now also runs when the text model finds no matching element for a click, for example a target described by its picture. Vision chooses among every visible control or abstains; an abstention keeps the step unresolved as before.

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

## 0.1.0-alpha.3

### Minor Changes

- 027b095: Find and choose page elements more reliably. The page script now reaches open
  shadow roots, pointer-styled controls with no role, drawn checkboxes and radios,
  and controls named only by an icon, image, placeholder, or nearby text, and it
  tells the model where each control sits. The locator resolves ordinals, prices,
  row references, and named sections in code, asks the model one yes/no question
  per item for references it cannot match, and gives up on steps that name only a
  kind of control or fit two near-namesakes. Among repeated elements it now acts on
  the model's pick by default (`repeatedMember: {}` restores the strict rule).
  A TypeSafe 402 (no credits) is reported as a configuration error.

### Patch Changes

- 3e2d8a6: Simplify locator acceptance by removing the explicit region veto, generic-word
  blacklist, and absolute selected-probability floor. Keep provider confidence,
  probability lead, repeated-control evidence, and browser-safety checks. Remove
  the redundant repeated-group lead check, which is implied by its support threshold.

## 0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- 99bd8ea: Improve live site control discovery and action freshness. Explicit ARIA labels
  can name hidden referenced text, overlong controls keep bounded visible names
  without poisoning unrelated choices, and visible targets are hit tested before
  scrolling. A pre-dispatch stale action can be resolved once against the current
  page; an action that may have started is never replayed. Dynamic candidate
  pagination preserves one snapshot while fresh target revalidation protects
  actions. Bounded empty-page and stale reads handle delayed navigation.
  Assertion digests include the named, rendered selection of select-only
  controls in document order, and a
  same-route page revision can retain a judgment only if a fresh complete
  digest is identical.
  Control discovery also accepts placeholder and title fallback names, and
  ranked-story phrasing retains the repeated-link safety check.
  Empty fill candidate scans briefly wait for late labels.

## 0.1.0-alpha.0

### Minor Changes

- ea32dc3: Add `--reporter markdown`, which writes `report.md` for coding agents beside `result.json`. The report puts the most urgent failure first and gives its evidence and a rerun command. Frames now live in a new directory for each attempt, so concurrent runs and retries never overwrite or delete each other's evidence. The HTML and markdown reports share one sort order (failed, incomplete, flagged, passed) and print a score with extra digits whenever two decimals would misstate its comparison with a decision line.
- b3e2ca2: Add `sedum run --parallel <n|auto>` to run tests in parallel lanes and `--shard-index`/`--shard-count` to split a suite across CI jobs deterministically. Each lane keeps one browser, and every attempt gets a fresh context plus its own `SEDUM_ATTEMPT_KEY`. Results stay in selection order. Model-provider requests share one concurrency cap (`--provider-concurrency`), and all lanes pause together for one 429 cooldown that honors `Retry-After`. A 429 no longer uses up a call's retry attempts; a call rate limited for five minutes ends the run with `provider_rate_limited`. Terminal output prints one block per test when lanes interleave. Locator cache write races are reported as `conflict`, and stale locks are recovered.
- bb4fa38: Prepare the first public npm alpha with Changesets versioning, reproducible candidate tarballs, provenance, three-platform package installation checks, and human-approved publication of the verified tarballs.

### Patch Changes

- b3e2ca2: Fix `--replay` making every `type` step fail as `stale`. Replay frames are now captured without Playwright hiding the text caret. Hiding it wrote inline styles onto form fields, and those counted as page changes, so the field located for the step looked out of date by the time it was filled.
