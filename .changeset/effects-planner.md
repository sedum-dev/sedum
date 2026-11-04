---
"@sedum-dev/core": patch
"sedum-cli": patch
---

Add an experimental effects planner to explore mode (`sedum explore --planner effects`, guided mode). Jev labels each control once with what it does, from a closed list of effects, and each form field with what it asks for. Code plans over an abstract map of the app: route templates with ids folded (UUIDs and other dashed ids included), forms, and each wizard step's forward controls. Repeated kinds of controls lose value, site-wide controls count once, forward steps gain value with depth, and a forward step that stalls asks Jev what blocks it. The walk stays on the start origin, and safety, oracles, traces and results work as before. The weighted walk stays the default; `result.json` now names the planner.
