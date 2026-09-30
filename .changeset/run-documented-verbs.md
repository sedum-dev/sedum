---
"@sedum-dev/core": patch
---

Run the documented `goto`, `press`, `scroll`, `wait` and `measure` steps. `sedum validate` accepted these verbs, but `sedum run` stopped on them with `unsupported_operation` and exit 3. Keys use Playwright names (`press enter` and `press the Esc key` both work), scrolls move about one screen, a `goto` address may contain `{{name}}` values, and `measure` records the judge's scores without gating the test.
