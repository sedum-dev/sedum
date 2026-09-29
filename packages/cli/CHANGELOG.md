# sedum-cli

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
