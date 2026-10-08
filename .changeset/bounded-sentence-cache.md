---
"@sedum-dev/core": patch
---

Improve sentence locator caching with role-aware target grammar and bounded product-context admission. Reject ambiguous or incomplete contextual evidence, repeat contextual uniqueness checks on hits, and invalidate older locator recipes with matcher5. Competing same-role control names prevent treating button/link as grammar at admission and on warm matches, with a context_not_unique miss. Current input bindings and live assertions are unchanged.
