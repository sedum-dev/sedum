---
"sedum-cli": minor
---

Choose the browser per machine or environment. `SEDUM_BROWSER` (process or
project `.env`) and a named environment's `browser` key now set the browser,
below `--browser` and above the top-level `browser` key. `sedum doctor` accepts
`--browser` and reports where the browser setting came from.
