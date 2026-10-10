# @sedum-dev/provider-clef

## 0.1.0-alpha.13

### Patch Changes

- @sedum-dev/core@0.1.0-alpha.13

## 0.1.0-alpha.12

### Patch Changes

- Updated dependencies [175e84c]
- Updated dependencies [be6d287]
  - @sedum-dev/core@0.1.0-alpha.12

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
