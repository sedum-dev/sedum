---
"@sedum-dev/core": patch
---

A step after a page change now waits for a busy page to hold still for `stepTimeoutMs` when that is longer than 4 seconds, instead of always giving up after 4 seconds. A page that never holds still now fails the step with `observation_timeout` instead of "could not run", so `--retries` reruns the test.
