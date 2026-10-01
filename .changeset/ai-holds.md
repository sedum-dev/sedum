---
"@sedum-dev/core": patch
"sedum-cli": patch
---

Branch on what the page shows. `await ai.holds("the passkey screen is shown")` judges a claim like a verify and returns `true` or `false`; it never fails the test and is recorded without a verdict. Use it for screens that appear only sometimes, such as an optional prompt, instead of reading the URL or the DOM in code.
