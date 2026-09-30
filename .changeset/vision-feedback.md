---
"sedum-cli": patch
"@sedum-dev/core": patch
---

Fix vision fallback never running when the page was still settling after a navigation. The screenshot's freshness check failed, and the error was swallowed as an ambiguous target. That case is now reported as stale, so the runner takes its one fresh observation and vision gets its turn.

Make vision's behavior visible. With vision enabled, `sedum run` checks `OPEN_ROUTER_API_KEY` against OpenRouter's unbilled key endpoint before tests start and warns in the summary when the key is rejected. The summary says how many steps used vision, or that vision was not needed. A click that fails without trying vision explains why. `sedum doctor` checks the vision key when vision is enabled, or with `--vision`.
