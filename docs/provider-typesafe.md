# TypeSafe provider

`@sedum-dev/provider-typesafe` implements the core `Resolver` and `Judge` interfaces with TypeSafe System One. Set `TYPESAFE_API_KEY` in the Node process running Sedum. The adapter uses the `jev-latest` model and the official TypeSafe HTTPS endpoint.

The Resolver sends a sentence and bounded page candidate descriptions: opaque run-local ID, tag, role, accessible name, up to two peer excerpts, and editable/disabled flags. The Judge sends a claim and a bounded page digest. Allowed text is sent **as-is** to TypeSafe. It may contain customer or secret-looking content; the adapter does not sanitize it. The request builder does not copy URL, title, selectors, raw DOM, hidden text, cookies, or editable field values from observation objects. Callers must supply a digest produced by the bounded page extraction protocol.

The adapter returns probabilities for every offered option, two independent Judge scores, reported token usage, and an estimated cost for the successful response. Its rate is checked into the source with a dated link. After retries, total cost is unknown because a failed attempt may have consumed tokens without reporting usage.

Normal tests use recorded responses and need no API key. To run the two-call live check, supply a key and explicitly opt in:

```sh
SEDUM_TYPESAFE_LIVE=1 TYPESAFE_API_KEY=... corepack pnpm exec vitest run packages/provider-typesafe/src/index.live.test.ts
```

The live check makes billable API calls. It prints model, usage, and estimated cost metadata only.
