---
"@sedum-dev/core": minor
"@sedum-dev/reporters": minor
"sedum-cli": minor
---

Add opt-in OpenRouter vision fallback for ambiguous repeated-control clicks,
with CLI/configuration support, labeled screenshots, validated candidate
selection, and safe request diagnostics. Existing Jev caching is unchanged;
vision selections are not cached.

Show vision fallback outcomes, models, and duration in HTML, Markdown, and CLI
reports, with separate text/vision token and cost summaries across all attempts.
Distinguish provider-reported vision cost from unavailable per-token pricing and
preserve known subtotals when some calls have unknown costs.
