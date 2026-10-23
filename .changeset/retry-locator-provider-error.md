---
"@sedum-dev/core": patch
---

A click or type step whose one model call to pick the target fails, for example on a timeout, now fails instead of "could not run", so `--retries` reruns the test. Provider failures that affect the whole run, such as a rejected API key, a configuration error or a rate limit, still stop the run as before.
