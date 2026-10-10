---
title: "TypeSafe provider"
---

## What Sedum sends, in short

Sedum sends the model the step's sentence and a bounded description of the
page: visible text, and the names and roles of elements. It does not send
cookies, raw HTML, hidden text, or the values in form fields. Secrets from the
environment are replaced by placeholders. Other visible page text is sent as
it is. Use `--sensitive-origin <url>` to keep a page's details and screenshots
out of saved results.

**Exception: experimental `run --affected`.** Test selection sends the retained
committed `merge-base(base, pinned HEAD)..pinned HEAD` diff and complete candidate
test/module sources. Dirty tracked state is refused even when ignored.
`affected.ignore` plus repeatable `--affected-ignore` filters repository-relative
paths before patch reads, but changed tests/module dependents are still forced.
Environment variables are not expanded; committed secrets and test literals
are transmitted as-is. Exclusions are not redaction or a privacy guarantee.
`--sensitive-origin` protects browser evidence, not these source inputs.

Lossless diff chunks prefer files, hunks, lines, then Unicode code points, with
repeated file/hunk metadata; full test/module sources are never truncated.
Serialized UTF-8 limits are 28,000 bytes for a diff plus one question and 56,000
per batch. A 16 MiB retained patch guard and preflight ceiling of 256 planned
requests fail closed, as does a complete candidate source that cannot fit.
Every non-forced candidate is scored against every chunk; its maximum score is
an experimental heuristic, not calibrated whole-PR probability. The default
cutoff is 0.3. All call receipts are retained; chunking adds billable calls,
tokens, and latency, separate from runner costs. Any chunk failure stops selection.
Review source before opting in. See [Git-diff selection](cli.md#experimental-git-diff-selection)
for clean-checkout commands, ignore semantics, and limits. Live accuracy remains
unverified; evaluation spending needs separate approval, and this is not a
mandatory CI gate.

In a terminal, Sedum shows token use and cost after each run. A
[local locator cache](locator-cache.md) skips repeat lookups during
development.

## Details

`@sedum-dev/provider-typesafe` implements the core `Resolver` and `Judge` interfaces with TypeSafe System One. Set `TYPESAFE_API_KEY` for the default TypeSafe endpoint. By default, the adapter uses the `jev-latest` model and the official TypeSafe HTTPS endpoint.

To use a TypeSafe System One-compatible service instead, set its complete
connection in the process or project-root `.env`:

```dotenv
TYPESAFE_BASE_URL=https://example.com
TYPESAFE_DEFAULT_MODEL=jev-compatible-model
TYPESAFE_API_KEY=...
```

These names match the TypeSafe SDK. Set the URL and key together for a custom
service: the configured key is sent to that URL. The service must implement
the TypeSafe SDK's `/v1/systemone` wire contract; an OpenAI-compatible chat API
is not sufficient. The configured model is included in provider receipts and
is used to separate classification cache entries.

## Vercel AI Gateway

Use Vercel's [TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe)
with the existing `typesafe` provider. In the project-root `.env`, set:

```dotenv
TYPESAFE_BASE_URL=https://ai-gateway.vercel.sh/typesafe
TYPESAFE_DEFAULT_MODEL=typesafe-ai/jev
TYPESAFE_API_KEY=your_vercel_ai_gateway_key
```

The key is a **Vercel AI Gateway key**, not a direct TypeSafe key. If your CI
already supplies `AI_GATEWAY_API_KEY`, map it explicitly before running Sedum:

```sh
export TYPESAFE_API_KEY="${AI_GATEWAY_API_KEY:?Set AI_GATEWAY_API_KEY}"
export TYPESAFE_BASE_URL=https://ai-gateway.vercel.sh/typesafe
export TYPESAFE_DEFAULT_MODEL=typesafe-ai/jev
npx sedum validate
npx sedum run
```

Plain `validate` is offline; `run`, `doctor`, and `validate --online` can make
billable requests. Sedum does not automatically read `AI_GATEWAY_API_KEY` or
switch endpoints when a gateway key is present. Set all three values together
so credentials go to the intended service. Do not commit keys.

Keep `provider.name: typesafe` (the default). If `provider.model` is set in
`sedum.config.yaml`, it overrides `TYPESAFE_DEFAULT_MODEL`; remove it or set it
to `typesafe-ai/jev`. Sedum calls `/typesafe/v1/systemone`, not the gateway's
Chat Completions or `/v1/evaluate` endpoint.

For programmatic use:

```typescript
import { TypeSafeAdapter } from "@sedum-dev/provider-typesafe";

const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
if (!apiKey) throw new Error("Set AI_GATEWAY_API_KEY before using Vercel.");

const provider = new TypeSafeAdapter({
  apiKey,
  baseURL: "https://ai-gateway.vercel.sh/typesafe",
  model: "typesafe-ai/jev",
});
```

Other [decision models](https://vercel.com/ai-gateway/models?modality=decision)
can use the same adapter with their gateway model ID, provided they support
the System One `choice` and `noul` contract. Model IDs are passed through,
not restricted to Jev. Other gateways work the same way if they expose that
contract. This does not route the direct Cloudflare `clef` provider through
Vercel or imply that Vercel offers Clef.

Sedum requires probabilities for every offered choice. Language-model
fallbacks returning `probabilities: {}` and `confidence: 0` are rejected;
Sedum cannot apply its confidence thresholds to missing probabilities.

Gateway receipts retain the requested and returned model IDs and token usage.
When the service supplies Vercel-style `provider_metadata.gateway.cost`, Sedum
records that USD amount, including zero, without applying direct Jev pricing.
Missing or invalid cost metadata leaves cost unknown. After a potentially
billable retry, the successful response cost is retained but total cost stays
unknown. Receipt provider identity remains `typesafe`, identifying the adapter.

## Request and response handling

The Resolver sends a sentence and bounded page candidate descriptions: opaque run-local ID, tag, role, accessible name, up to two peer excerpts, and editable/disabled flags. The Judge sends a claim and a bounded page digest. Allowed text is sent **as-is** to TypeSafe. It may contain customer or secret-looking content; the adapter does not sanitize it. The request builder does not copy URL, title, selectors, raw DOM, hidden text, cookies, or editable field values from observation objects. Callers must supply a digest produced by the bounded page extraction protocol.

The adapter returns probabilities for every offered option, two independent Judge scores, reported token usage, and an estimated cost for the successful response. Its rate is checked into the source with a dated link. After retries, total cost is unknown because a failed attempt may have consumed tokens without reporting usage.

Normal tests use recorded responses and need no API key. To run the two-call live check, supply a key and explicitly opt in:

```sh
SEDUM_TYPESAFE_LIVE=1 TYPESAFE_API_KEY=... corepack pnpm exec vitest run packages/provider-typesafe/src/index.live.test.ts
```

The live check makes billable API calls. It prints model, usage, and estimated cost metadata only.
