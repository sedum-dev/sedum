---
"@sedum-dev/core": patch
---

Simplify locator acceptance by removing the explicit region veto, generic-word
blacklist, and absolute selected-probability floor. Keep provider confidence,
probability lead, repeated-control evidence, and browser-safety checks. Remove
the redundant repeated-group lead check, which is implied by its support threshold.
