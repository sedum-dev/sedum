---
"@sedum-dev/core": patch
"@sedum-dev/provider-typesafe": patch
---

Make the documented Sauce Demo goal example pass, and explain goal abstentions. The planner split its probability between the next step and `BLOCKED` (for example TYPE 0.50 vs BLOCKED 0.48 on the login page), so the goal abstained before acting or before placing the order. `BLOCKED` now means that no offered element can move the goal forward, and every step the goal names counts as expected. A goal action whose target went stale before dispatch is now taken back and the page observed again, instead of failing the goal. A goal that abstains reports which decision was uncertain, on which page, and its top probabilities, with a hint on how to rewrite the goal.
