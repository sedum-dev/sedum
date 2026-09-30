---
"sedum-cli": patch
"@sedum-dev/core": patch
---

Keep running the rest of the suite when one test cannot run. Previously the first test-scoped error, such as an unsupported step, stopped `sedum run` and the remaining selected tests never ran. That test is now recorded with `state: "error"`, and every other test still gets a verdict. The run still exits 3, and the summary says how many tests could not run. A missing browser, a rejected provider key, or sustained rate limiting still stops the run immediately.

A rejected provider key is now reported as `provider_authentication` and stops the run at the first request, instead of surfacing as `Could not resolve this click step` in every test.
