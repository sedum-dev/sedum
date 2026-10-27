# @sedum-dev/provider-clef

## 0.1.0-alpha.20

### Patch Changes

- Updated dependencies [6751e12]
- Updated dependencies [d20c714]
- Updated dependencies [038122d]
  - @sedum-dev/core@0.1.0-alpha.20

## 0.1.0-alpha.19

### Patch Changes

- Updated dependencies [75e5784]
- Updated dependencies [30780f1]
- Updated dependencies [01541dc]
- Updated dependencies [18d0aff]
  - @sedum-dev/core@0.1.0-alpha.19

## 0.1.0-alpha.18

### Patch Changes

- Updated dependencies [d793836]
  - @sedum-dev/core@0.1.0-alpha.18

## 0.1.0-alpha.17

### Patch Changes

- Updated dependencies [8e0aeef]
- Updated dependencies [6da2a50]
  - @sedum-dev/core@0.1.0-alpha.17

## 0.1.0-alpha.16

### Patch Changes

- @sedum-dev/core@0.1.0-alpha.16

## 0.1.0-alpha.15

### Patch Changes

- Updated dependencies [92062ac]
- Updated dependencies [00f845c]
- Updated dependencies [7577020]
  - @sedum-dev/core@0.1.0-alpha.15

## 0.1.0-alpha.14

### Patch Changes

- Updated dependencies [f1d726d]
- Updated dependencies [14e0ad8]
- Updated dependencies [1d12b31]
  - @sedum-dev/core@0.1.0-alpha.14

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
