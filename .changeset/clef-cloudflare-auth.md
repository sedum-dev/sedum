---
"sedum-cli": patch
---

Accept `CLOUDFLARE_API_TOKEN` as an alias for Clef while preserving
`CLOUDFLARE_AUTH_TOKEN`, rejecting ambiguous same-level values, and keeping
both secrets out of test variables. Make run, affected-selection, validation,
and doctor failures name Cloudflare account access and Workers AI permissions
instead of incorrectly recommending `TYPESAFE_API_KEY`.
