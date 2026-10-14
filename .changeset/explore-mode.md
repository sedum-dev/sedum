---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
"@sedum-dev/reporters": minor
---

Add experimental `sedum explore <url>`: a seeded random walk over the
candidate scanner, guided by Jev (page kind, where targets lead, field
values, dropdown options, form purpose), that reports console errors,
uncaught exceptions, unhandled rejections, failed requests, HTTP 5xx and
broken links, and with `--detect semantic` the bug detector's page checks.
A form macro completes forms, wizards and sub-forms; the walk returns to
unfinished pages by URL. Safety is off by default (the walk never logs
itself out); `--safe` skips what Jev judges destructive and `--safe strict`
adds a keyword list. Each run writes `trace.jsonl`, `result.json`,
`report.md` and `report.html` (frames with `--replay`); `--shrink` turns
failures into plain-English tests and `--rerun` runs a trace again.
