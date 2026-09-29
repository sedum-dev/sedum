# @sedum-dev/core

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
