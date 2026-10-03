---
"@sedum-dev/core": patch
---

Re-observe goal pages when a target becomes stale before dispatch, while preserving exact target freshness, generated-value privacy, and no-replay guarantees. Stale and blocked goal reports now include actionable safe page, target, frame, and Faker-generator context without exposing generated values.
