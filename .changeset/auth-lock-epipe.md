---
"sedum-cli": patch
---

End quietly when a reader closes stdout early, as with `| true`, `| head`, or a failing `jq`, instead of crashing with an unhandled `EPIPE`. The authentication store lock is now released on any exit, and a lock left by a killed process on the same host is detected and cleared automatically. A lock held by a live or paused process still blocks, so concurrent refresh-token rotation stays serialized.
