# TypeSafe provider

## What Sedum sends, in short

Sedum sends the model the step's sentence and a bounded description of the
page: visible text, and the names and roles of elements. It does not send
cookies, raw HTML, hidden text, or the values in form fields. Secrets from the
environment are replaced by placeholders. Other visible page text is sent as
it is. Use `--sensitive-origin <url>` to keep a page's details and screenshots
out of saved results.

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

The Resolver sends a sentence and bounded page candidate descriptions: opaque run-local ID, tag, role, accessible name, up to two peer excerpts, and editable/disabled flags. The Judge sends a claim and a bounded page digest. Allowed text is sent **as-is** to TypeSafe. It may contain customer or secret-looking content; the adapter does not sanitize it. The request builder does not copy URL, title, selectors, raw DOM, hidden text, cookies, or editable field values from observation objects. Callers must supply a digest produced by the bounded page extraction protocol.

The adapter returns probabilities for every offered option, two independent Judge scores, reported token usage, and an estimated cost for the successful response. Its rate is checked into the source with a dated link. After retries, total cost is unknown because a failed attempt may have consumed tokens without reporting usage.

Normal tests use recorded responses and need no API key. To run the two-call live check, supply a key and explicitly opt in:

```sh
SEDUM_TYPESAFE_LIVE=1 TYPESAFE_API_KEY=... corepack pnpm exec vitest run packages/provider-typesafe/src/index.live.test.ts
```

The live check makes billable API calls. It prints model, usage, and estimated cost metadata only.
