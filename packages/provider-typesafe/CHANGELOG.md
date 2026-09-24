# @sedum-dev/provider-typesafe

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
