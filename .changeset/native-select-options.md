---
"@sedum-dev/core": patch
---

Choose options in native `<select>` dropdowns. A click resolved to a native dropdown used to click the control, which changes nothing, and still report the step as passed. Now `click the "Price (low to high)" option in the sort dropdown` and `select "Price (low to high)" in the sort dropdown` choose that option. A click on a native dropdown that names no option fails and lists the options instead of passing silently. Quoted `select`, `choose`, and `pick` sentences classify offline without a model call.
