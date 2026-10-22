---
"@sedum-dev/core": patch
"sedum-cli": patch
---

Click and type steps right after a page change no longer need a `wait until …` step before them. A target that a render pass replaces while it is being located is located again, on busy pages too, until the page holds still. A click that Playwright refused before sending any input is retried against the new target. A step whose target never holds still now fails instead of "could not run", so `--retries` reruns it. A located button that stays disabled, or a field that stays read-only, now waits for the step timeout when that is longer than 8 seconds, and a quoted-text check keeps reading a page that is mid-navigation. Set the step timeout with `stepTimeoutMs` in `sedum.config.yaml`, per environment if needed.
