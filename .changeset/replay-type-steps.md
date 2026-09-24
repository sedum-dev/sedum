---
"@sedum-dev/core": patch
---

Fix `--replay` making every `type` step fail as `stale`. Replay frames are now captured without Playwright hiding the text caret. Hiding it wrote inline styles onto form fields, and those counted as page changes, so the field located for the step looked out of date by the time it was filled.
