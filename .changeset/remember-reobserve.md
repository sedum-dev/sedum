---
"@sedum-dev/core": patch
---

Fix `remember` failing with `stale: The remember target could not be resolved.` when the page was still settling after a navigation, for example a login redirect that rewrites its URL or fills in content. A `remember` step now gets the same single fresh observation after a stale resolution, and the same wait for an empty page to fill, that `click` and `type` steps already had.
