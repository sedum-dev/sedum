---
"@sedum-dev/core": patch
---

A quoted-text check whose page text is still unreadable when the step times out now fails with `text_unreadable` instead of "could not run", so `--retries` reruns the test.
