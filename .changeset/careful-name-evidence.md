---
"@sedum-dev/core": patch
---

Compare repeated controls by name rather than shared URLs, mask incidental
counts without overriding explicit numeric requests, and reject lexical misses
and competing near-names. Apply the checks to cached targets and invalidate
recipes written before these matching rules.
