---
"@sedum-dev/core": minor
"sedum-cli": minor
---

Add explicit global `locator.ambiguity: reject | first` policies. Reject requires
a uniquely justified target; first chooses in DOM collection order only within
a conservatively proven matching set, retaining freshness and actionability
checks. Omission preserves the existing repeated-control model-pick behavior.
Explicit policies bypass identity-only locator caches. Expose the locator gate
in canonical JSON results, including `ambiguity_first` for permissive selection.
