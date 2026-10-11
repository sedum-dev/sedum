---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
"@sedum-dev/reporters": minor
---

Add an experimental bug detector, `--detect browser|semantic`, that flags steps
whose page looks broken without authored claims. Browser mode reports console
errors, uncaught exceptions, unhandled rejections, and 4xx/5xx or failed
responses for every request, including fetch and XHR, plus exact text leaks such
as `undefined` and `{{template}}`. Semantic mode adds one cached Jev call per
new page state for visible errors, stuck loading, empty sections, and broken
values, with a severity Score. Findings are `suspected_bug` step flags with
`detections`; they never fail a step. `--detect-allow` ignores known noise.
