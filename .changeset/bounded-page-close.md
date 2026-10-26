---
"@sedum-dev/core": patch
---

A run on a page that keeps reloading now finishes. Chromium can accept a page
close while the page reloads and then keep the tab open, and the run waited for
it forever: it wrote no `result.json`, stayed `running` in `progress.json`, and
ignored Ctrl-C. Sedum now stops waiting after 2 seconds and closes the page's
browser context, which always disposes it, so retries, Ctrl-C and
`--timeout-minutes` report their results again.
