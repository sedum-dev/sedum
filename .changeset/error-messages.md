---
"sedum-cli": patch
"@sedum-dev/core": patch
"@sedum-dev/reporters": patch
---

Clearer error messages:

- An unreachable test URL now reports `navigation_failed` with the cause, e.g. "Could not open the test's page: the host name could not be resolved (DNS)", instead of "The browser run could not be completed safely".
- A missing test path is named in the final error instead of blaming `sedum.config.yaml`'s `tests.include`.
- A misspelt key in `sedum.config.yaml` gets a "Did you mean `browser`?" fix, as test files already do.
- A run that never started a test no longer prints "read …" hints.
- An unresolved step says why (no element matches, several match, or nothing to click), and its error code is `no_match` instead of `none`.
- `report.md` labels an error "browser error, untrusted" only when it came from the browser.
- A test file with neither `steps` nor `goal` is told so, instead of "…but not both".
- An unexpected internal error is no longer reported as "The command could not be parsed safely".
