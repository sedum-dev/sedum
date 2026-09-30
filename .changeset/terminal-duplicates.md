---
"sedum-cli": patch
"@sedum-dev/reporters": patch
---

Stop repeating lines in `sedum run` terminal output. Each test's result line appeared twice, the `progress` path twice, and the cost three ways ("Text models", "All models (all attempts)", and "model … / cost …"). The final summary now adds only per-test details (retries and cache outcomes) under the test's file, names `progress.json` once at the start, and shows one cost breakdown. "All models" appears only when vision calls make it differ from "Text models", and an incomplete cost is still called out.
