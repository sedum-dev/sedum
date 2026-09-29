# @sedum-dev/provider-typesafe

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
