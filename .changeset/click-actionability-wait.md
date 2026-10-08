---
"@sedum-dev/core": patch
---

Wait for temporarily disabled, hidden, or covered click targets instead of failing immediately. Safe pre-dispatch refusals and stale-target re-resolution share an eight-second action budget after initial resolution; actions that may already have started are never replayed. Report the last refusal and elapsed wait on expiry. Near-ties with no match can re-resolve after page changes within the existing target-wait grace without weakening selection thresholds.
