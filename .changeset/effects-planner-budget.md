---
"@sedum-dev/core": patch
"sedum-cli": patch
---

The explore effects planner (`--planner effects`) now spends its whole step budget: when its plan is used up it sweeps what is left, replays to its deepest states in a fresh session, and then hands the remaining steps to the walk planner (`effects.walkFrom` in `result.json`). It learns which states loading a URL restores and replays the path from the nearest one that it does, finishes a flow's forward steps before switching, leaves out disabled, `pointer-events: none` and covered controls (and controls whose clicks changed nothing twice), fills only the target's own form, and signs in with the account it registered.
