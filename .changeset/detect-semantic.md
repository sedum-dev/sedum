---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
"@sedum-dev/reporters": minor
---

Add experimental `--detect semantic`. On top of the browser checks, each new
page state gets one cached System One call asking whether the page shows an
application error, is stuck loading, has an empty section, or shows a broken
value, with a severity Score. Exact leaks such as `undefined` and
`{{template}}` are reported when Jev confirms a broken value. Findings carry
`source`, `probability`, and `severity`; detector calls have purpose
`detector`. Providers other than TypeSafe and OpenRouter stop the run with
`detect_unsupported`.
