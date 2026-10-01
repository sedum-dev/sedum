---
"@sedum-dev/core": patch
"sedum-cli": patch
---

Wait for the page the way a person does. `wait until the reply is shown` (or `wait up to 90 seconds until …`, 30 seconds by default, at most 120) judges its claim again each time the page changes and passes as soon as it holds, through slow server responses and redirects. The CLI also gives a failing `verify`, and a click or type whose target is not on the page yet, a 5-second grace like Playwright's auto-wait: the step is judged or located again only when the page changes, so a page that stays put costs no extra model calls. Set `SEDUM_VERIFY_GRACE_MS=0` to judge once.
