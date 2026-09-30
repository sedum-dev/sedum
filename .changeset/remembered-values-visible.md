---
"@sedum-dev/core": patch
---

Stop redacting remembered page values in reports. `remember the price … as {{price}}` treated the price as a secret, so every later occurrence of `$ 29.99` in a failed step's excerpt read `[REDACTED]`, and a short value such as `1` blanked every matching substring. A remembered value is now redacted only when it was read on a sensitive origin or contains an environment-derived secret.
