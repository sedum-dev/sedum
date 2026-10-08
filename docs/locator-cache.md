---
title: "Local locator cache"
---

Sedum can remember how it found a browser control. On a later run, it checks
that recipe against the current page. A unique, actionable match skips the
locator model call. An absent, changed, ambiguous, or invalid recipe is a cache
miss; Sedum uses the normal resolver and reports the reason. A cache miss is not
an assertion verdict or automatic target healing.

## When it runs

The local cache is enabled by default when `sedum run` starts inside a Git
checkout during development. It is off by default in CI and always off outside
Git. A fresh clone has no cache. `--no-locator-cache` disables it for one run.
Targets that depend on a runtime placeholder bypass the cache.
In CI, `--locator-cache-ci` or `SEDUM_LOCATOR_CACHE_CI=1` opts in; an explicit
`--no-locator-cache` wins. Opting in still requires a Git checkout. Set `CI=0`
or `CI=false` only when the environment is genuinely a development run.

```sh
sedum run tests/cart.test.yaml --no-locator-cache
sedum run tests/cart.test.yaml --locator-cache-ci
sedum cache clear
```

`sedum cache clear` removes the cache **and its digest key** for the current
worktree. The files are in that worktree's Git metadata, outside the tracked
tree; Sedum does not change the project's `.gitignore`. A linked worktree has
its own cache. There is no age-based expiry in 0.1. Incompatible formats or
matching rules, corrupt data, and failed current-page validation cause misses
and invalidation. Local files are not uploaded to a hosted cache.

## Parallel lanes

Lanes and concurrent runs in one worktree share the cache safely:

- Each entry is written under its own lock and moved into place atomically.
- An invalidation removes an entry only if it still holds the recipe that lane saw.
- A lock left by a crashed run is broken once it is more than ten seconds old.

If a lane cannot get an entry's lock in about two seconds, the step records the cache reason `conflict` and keeps its model result, and the run summary counts the conflict. The test itself is unaffected.

## What is retained

The stored key is a keyed digest of the full origin, path, query, fragment,
operation, and normalized target sentence. For `type` steps, Sedum removes the
value operand before making this key, so different values for the same field
can reuse one recipe. The recipe contains bounded role,
tag, input type, state, and structural path, plus keyed digests of permitted
identity and nearby-label signals. It does not store the raw URL, sentence,
labels, page text, current input values, or HTML. The 256-bit digest key stays
beside the cache in Git metadata. Digests reduce accidental disclosure from a
copied cache entry; a person who can read both the entry and key may still
test guesses against them. Clear the cache when working with sensitive pages
or when sharing the checkout's Git metadata.

The cache is separate from the classification cache in `.sedum/`. On a miss,
the normal Resolver may send the step sentence and allowed page excerpts to
the configured model provider; see [TypeSafe provider](provider-typesafe.md)
and [Clef provider](provider-clef.md). Locator recipes are provider-independent:
a locally revalidated hit can be reused after changing providers, so that hit
does not test the selected provider's decision quality.
Run results and evidence have their own privacy controls in
[run results](run-result.md).

Each action's `RunResult.locator.cache` records `hit`, `miss`, or `bypassed`,
the reason, whether fallback called the locator model, and proven target-change
evidence. Terminal output shows the same outcome. A changed or stale recipe
remains visible even when the subsequent model-selected action succeeds.
A miss with reason `not_cacheable` means the target has no signal that can
safely find it again, for example an `<input type="submit">` button whose
name is its runtime value, so that step always uses the model. A run outside a
Git checkout reports `bypassed (outside_git)` and prints a hint to run
`git init`.

## Which steps are cached

Sedum stores a recipe only after the action succeeds, and only when safe
signals can tell the target apart from every other current control. Words in
the sentence beyond the target's own label are treated as context that the
target must satisfy. A role noun next to the label is grammar, not context:
`click the Checkout button` and `click the Docs link` can be cached like
`click Checkout`. The noun stays context when it does not match the chosen
control's role, when it is not beside the label (`click Add to cart for the
Red Button`), or when another control of the same role has the noun in its
name, such as a second button called `Checkout button`. If such a control
appears after a recipe was saved, the next run reports
`miss (context_not_unique)`, removes the recipe, and uses the model.

## What a hit proves

A hit means the current page has exactly one control that matches the saved
recipe. It does not prove that clicking the control still has the same
effect. A button can keep its label, ID, and surroundings while its handler or
the server behind it changes. Sedum still runs every assertion after a cached
action, so a changed outcome fails the test, but only after the action has
happened. Keep assertions for outcomes that matter, especially after actions
that cannot be undone.
