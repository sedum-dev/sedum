---
"@sedum-dev/reporters": patch
---

Stop the HTML report's CONF, MS and COST columns from wrapping mid-number (`0.⏎95`, `20⏎5m⏎s`, `$0.0⏎0007⏎8`) when a long step, such as a goal, squeezes the table. Number cells and column headers no longer wrap.
