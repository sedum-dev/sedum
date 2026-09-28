---
"@sedum-dev/core": patch
"@sedum-dev/reporters": patch
---

Act on the model's choice among repeated elements instead of giving up. Record
how many similar elements were considered, keep these ambiguous picks out of
the locator cache, and surface the decision in terminal, Markdown, and HTML
reports.
