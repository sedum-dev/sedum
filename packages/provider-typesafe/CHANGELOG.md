# @sedum-dev/provider-typesafe

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

## 0.1.0-alpha.10

### Patch Changes

- @sedum-dev/core@0.1.0-alpha.10

## 0.1.0-alpha.9

### Patch Changes

- Updated dependencies [9640bbb]
- Updated dependencies [af96cef]
- Updated dependencies [388a60b]
- Updated dependencies [bdcf5bd]
  - @sedum-dev/core@0.1.0-alpha.9

## 0.1.0-alpha.8

### Minor Changes

- 89cbfc8: Add Cloudflare Clef and Clef-flash as opt-in text decision providers while
  keeping TypeSafe as the default. Include provider-aware classification caches,
  provider identity in compatible receipts, fixed Cloudflare routing, CLI and
  doctor integration, bounded retries, and all six text decision operations.

### Patch Changes

- Updated dependencies [89cbfc8]
- Updated dependencies [947e960]
  - @sedum-dev/core@0.1.0-alpha.8

## 0.1.0-alpha.7

### Patch Changes

- Updated dependencies [4985099]
- Updated dependencies [db3272b]
- Updated dependencies [9a94894]
- Updated dependencies [9e2bec1]
- Updated dependencies [16e7c00]
- Updated dependencies [245261c]
- Updated dependencies [757f45f]
  - @sedum-dev/core@0.1.0-alpha.7

## 0.1.0-alpha.6

### Patch Changes

- Updated dependencies [8dd5d42]
- Updated dependencies [892c784]
  - @sedum-dev/core@0.1.0-alpha.6

## 0.1.0-alpha.5

### Patch Changes

- c135228: Make the documented Sauce Demo goal example pass, and explain goal abstentions. The planner split its probability between the next step and `BLOCKED` (for example TYPE 0.50 vs BLOCKED 0.48 on the login page), so the goal abstained before acting or before placing the order. `BLOCKED` now means that no offered element can move the goal forward, and every step the goal names counts as expected. A goal action whose target went stale before dispatch is now taken back and the page observed again, instead of failing the goal. A goal that abstains reports which decision was uncertain, on which page, and its top probabilities, with a hint on how to rewrite the goal.
- Updated dependencies [9131d3c]
- Updated dependencies [834b723]
- Updated dependencies [a8f641d]
- Updated dependencies [c5469e4]
- Updated dependencies [0ddfcad]
- Updated dependencies [c135228]
- Updated dependencies [e83c74c]
- Updated dependencies [0662f50]
- Updated dependencies [cbd82f1]
- Updated dependencies [acae6ef]
- Updated dependencies [62db939]
- Updated dependencies [fd55a18]
- Updated dependencies [2fbd519]
  - @sedum-dev/core@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- Updated dependencies [2300463]
- Updated dependencies [20ae8f2]
  - @sedum-dev/core@0.1.0-alpha.4

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
- 4b50aa6: Add experimental `sedum run --affected` selection using one Jev relevance probability per test against a Git merge-base diff. Include a JSON preview, configurable base and threshold, complete module context, and explicit failure handling without silently skipping tests.

### Patch Changes

- Updated dependencies [027b095]
- Updated dependencies [3e2d8a6]
  - @sedum-dev/core@0.1.0-alpha.3

## 0.1.0-alpha.2

### Minor Changes

- 978f16e: Allow Sedum to use TypeSafe System One-compatible services through the
  `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, and `TYPESAFE_API_KEY`
  environment variables, matching the TypeSafe SDK.

### Patch Changes

- @sedum-dev/core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Patch Changes

- Updated dependencies [99bd8ea]
  - @sedum-dev/core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- b3e2ca2: Add `sedum run --parallel <n|auto>` to run tests in parallel lanes and `--shard-index`/`--shard-count` to split a suite across CI jobs deterministically. Each lane keeps one browser, and every attempt gets a fresh context plus its own `SEDUM_ATTEMPT_KEY`. Results stay in selection order. Model-provider requests share one concurrency cap (`--provider-concurrency`), and all lanes pause together for one 429 cooldown that honors `Retry-After`. A 429 no longer uses up a call's retry attempts; a call rate limited for five minutes ends the run with `provider_rate_limited`. Terminal output prints one block per test when lanes interleave. Locator cache write races are reported as `conflict`, and stale locks are recovered.
- bb4fa38: Prepare the first public npm alpha with Changesets versioning, reproducible candidate tarballs, provenance, three-platform package installation checks, and human-approved publication of the verified tarballs.

### Patch Changes

- Updated dependencies [ea32dc3]
- Updated dependencies [b3e2ca2]
- Updated dependencies [b3e2ca2]
- Updated dependencies [bb4fa38]
  - @sedum-dev/core@0.1.0-alpha.0
