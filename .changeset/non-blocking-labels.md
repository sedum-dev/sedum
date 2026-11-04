---
"sedum-cli": minor
"@sedum-dev/core": minor
"@sedum-dev/reporters": minor
---

Add `sedum run --non-blocking-labels <tags>` to quarantine flaky tests without skipping them. Tests with any of the tags run and are reported as usual, but their failures and test-scoped errors do not fail the run or the exit code. `result.json` marks them `"blocking": false` and counts their failures in `totals.nonBlockingFailedTests`; `totals.failedTests` now counts blocking failures only. The terminal summary, the Markdown and HTML reports, and JUnit show non-blocking failures separately. JUnit records them as skipped.
