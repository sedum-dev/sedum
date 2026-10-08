---
"sedum-cli": patch
"@sedum-dev/core": patch
---

Cache repeated `<button>` steps whose item text is too long to keep whole, such as `click Add to cart for Sauce Labs Backpack`, when the button has a unique ID, the item's title contains every context word in the sentence, and no other same-named button's title does. Every warm run checks this again on the current page and reports `cache miss (context_not_unique)` when a matching duplicate appears. The locator matcher version is now 3, so existing recipes miss once and are saved again.
