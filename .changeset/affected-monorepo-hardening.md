---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
"@sedum-dev/provider-clef": minor
---

Harden experimental affected-test selection for large monorepos. Pin committed
Git inputs, refuse dirty tracked files and index flags that can hide local edits,
and add additive `affected.ignore` and repeatable `--affected-ignore` path filters.
Changed tests and module dependents remain selected even when ignored.

Score retained diffs with lossless, preflighted file/hunk/line/Unicode chunks in
both providers, preserve complete candidate test/module sources, and aggregate
relevance with the maximum score across chunks. Enforce explicit retained-diff
and request-count guards, preserve all receipts, and fail on incomplete scoring.
Keep the default threshold at 0.1 and selection experimental; live relevance
accuracy remains unverified.
