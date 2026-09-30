---
"sedum-cli": patch
"@sedum-dev/core": patch
---

Report `cache miss (not_cacheable)` for a target the locator cache never stores, such as an `<input type="submit">` button, instead of `cache miss (absent)`, which implied the next run would hit. A run outside a Git checkout now prints a hint to run `git init` to enable the cache, and the README Quickstart includes `git init`.
