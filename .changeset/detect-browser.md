---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/reporters": minor
---

Add `--detect browser`, which flags steps whose page reported a console error,
an uncaught exception, an unhandled promise rejection, or an HTTP 4xx/5xx or
failed response, including `fetch` and XHR requests. Findings are a new
`suspected_bug` step flag with `detections` on the step that caused them; they
never fail a step, and `--strict` exits 2 for them. `--detect-allow` ignores
known noise. Detection makes no model calls.
