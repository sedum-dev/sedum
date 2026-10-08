---
"sedum-cli": patch
"@sedum-dev/core": patch
---

Cache sentence steps that name a control's role next to its label, such as `click the Checkout button` or `click the Docs link`; the noun no longer counts as unmet context. The noun still counts when another control of the same role has it in its name. If such a control appears after a recipe was saved, the step reports `cache miss (context_not_unique)` and uses the model. The locator matcher version is now 2, so existing recipes miss once and are saved again.
