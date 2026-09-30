---
"sedum-cli": patch
"@sedum-dev/core": patch
"@sedum-dev/reporters": patch
---

Flag a test that passes only after a failed attempt as `flaky`. It still counts as passed, but the flag appears on the test, in the run's flags, in the terminal summary (`flaky N test(s)`) and in JUnit output, and `--strict` exits 2 as for any flagged pass. Previously `--retries` could hide a flaky test completely.
