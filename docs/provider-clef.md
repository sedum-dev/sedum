---
title: "Clef provider"
---

Cloudflare Clef is an opt-in text decision provider. TypeSafe with
`jev-latest` remains Sedum's default. Select Clef in `sedum.config.yaml`:

```yaml
provider: { name: clef, model: clef }
```

`model` must be `clef` or `clef-flash`. Set `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_AUTH_TOKEN` in the invoking environment or project-root `.env`.
Sedum also accepts Cloudflare's conventional `CLOUDFLARE_API_TOKEN` as an
alias. Process values take precedence over `.env` across both token names. If
both names at the winning level contain different tokens, Sedum rejects the
ambiguous configuration; keep one name or make their values identical. Never
commit `.env`; credentials are excluded from test-data expansion and reports.
Sedum uses Cloudflare's fixed HTTPS Workers AI route. Custom Cloudflare
endpoints are not supported.

## Set up Cloudflare and run Sedum

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/) and
   select the account you want to use. Open **Workers AI → Use REST API**.
2. Select **Create a Workers AI API Token**, review its account access, then
   create and copy the token. Prefer this scoped token over a Global API Key.
   If creating a custom token, grant **Workers AI: Read** and **Workers AI:
   Edit** for the selected account. See Cloudflare's
   [REST API setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).
3. Copy the **Account ID** shown on that page. This is the 32-character account
   identifier, not a zone ID or token ID.
4. In an initialized Sedum project, add the following to the project-root
   `.env`, substituting your own values. Keep this file out of Git; in CI,
   inject both values through your CI secret store instead.

   ```dotenv
   CLOUDFLARE_ACCOUNT_ID=your_account_id
   CLOUDFLARE_AUTH_TOKEN=your_workers_ai_api_token
   # CLOUDFLARE_API_TOKEN is accepted as an alias for the line above.
   ```

5. Add `provider: { name: clef, model: clef }` to `sedum.config.yaml`. Use
   `model: clef-flash` to select Flash. A TypeSafe API key is not required when
   Clef is selected. New to Sedum? Follow the [quickstart](https://github.com/sedum-dev/sedum#quickstart)
   to install the CLI, initialize a project, and install its browser, then use
   these Cloudflare credentials instead of `TYPESAFE_API_KEY`.
6. From that project's root, check the setup and run its tests:

   ```sh
   npx sedum doctor
   npx sedum validate
   npx sedum run
   ```

`doctor` and `run` can make billable requests. Plain `validate` is offline;
use `npx sedum validate --online` when you want the selected provider to
classify unresolved steps. Authentication failures usually mean the token's
account access or Workers AI permissions do not match the configured account.
Check those in the dashboard without pasting the token into logs or reports.

You do not need Workers Paid to use the daily free allocation. Cloudflare
includes Workers AI in Workers Free; once its free limits are exceeded,
requests fail until the allocation resets at **00:00 UTC**. Workers Paid is
required for usage beyond the free allocation and bills that excess. Monitor
account-wide usage in the Workers AI dashboard; see
[Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).
No Worker deployment, domain, or separate vision service is needed for this
text adapter.

## Scope and data sent

Phase 1 supports six text operations: step classification, target resolution,
repeated-item verification, assertion judging, goal planning, and affected-test
relevance scoring. Inputs are bounded and choices are restricted to options
Sedum supplies; Clef cannot return arbitrary actions or selectors. Normal
browser decisions send the same bounded projection described in the
[TypeSafe provider](provider-typesafe.md): a sentence or claim and allowed
visible text/candidate fields, not cookies, raw HTML, hidden text, or editable
field values. Allowed visible text is not sanitized and can contain customer
data.

`run --affected` is broader: it sends the retained committed
`merge-base(base, pinned HEAD)..pinned HEAD` diff plus complete candidate test
and referenced module source. Dirty tracked state is refused even when ignored.
Additive `affected.ignore` and repeatable `--affected-ignore` filter repository-root
paths before patch reads, without preventing forced changed-test/module selection.
Environment variables are not expanded, but committed secrets, test literals,
and private source are sent as written. Glob exclusions are not redaction or a
privacy guarantee. Review the source before opting in; `--sensitive-origin`
does not protect these inputs.

Lossless chunks prefer files, hunks, lines, then Unicode code points, retaining
deletions and repeating file/hunk metadata. Complete test/module sources are not
truncated. Serialized UTF-8 ceilings are 28,000 bytes for a diff plus one
question, 56,000 bytes per batch, and **64 questions per Clef request**. The
16 MiB retained patch guard is a provisional local memory limit; the ceiling
of 256 planned provider requests is a provisional cost guard. Requests are all
preflighted before the first call, including complete source fit checks.
Any chunk failure is fatal, with no partial selection or automatic full-suite
fallback. Every non-forced candidate is scored against every chunk; the maximum
score is a heuristic, not a calibrated whole-PR probability. The default cutoff
remains 0.1. Chunking adds calls, tokens, latency, receipts, and possible costs,
reported separately from execution. See [Git-diff selection](cli.md#experimental-git-diff-selection)
for clean-checkout commands and ignore semantics. Live accuracy is unverified;
spending on an accuracy experiment requires separate approval. Keep full-suite
CI rather than making this experimental selector a mandatory gate.

Clef is text-only in this release. Selecting it does not enable image upload.
Existing vision fallback remains an independent, explicit OpenRouter opt-in
using `vision.enabled` or `--vision`. Clef screenshot fallback and image-first
decisions are deferred to later phases.

## Caches, receipts, and cost

Classification cache entries include provider and model identity, so changing
either causes a miss; legacy entries apply only to TypeSafe. The local locator
cache remains provider-independent and revalidates recipes on the current
page. A locator-cache hit avoids Clef and therefore says nothing about Clef's
decision quality.

Receipts include requested and returned model, attempts, reported tokens,
queue/rate-limit waits, and provider identity. The optional provider field
keeps existing RunResult v1 files readable, though older strict readers must be
upgraded to accept the added field. Failed retries may have unknown billing,
so their total cost remains unknown.

Published Workers AI input rates are **$0.24 per million tokens for `clef`**
and **$0.09 per million tokens for `clef-flash`** (checked 2026-10-01). Output
tokens are priced at $0 under these published rates. Cloudflare includes 10,000 neurons per day on
its free allocation, shared with other Workers AI usage; this is not a promise
that a Sedum run will be free.

`sedum doctor` makes one small authenticated Clef inference request and may be
billed. Normal tests use recorded responses. Live adapter tests are separately
opt-in and billable:

```sh
SEDUM_CLEF_LIVE=1 \
  CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_AUTH_TOKEN=... \
  corepack pnpm exec vitest run packages/provider-clef/src/index.live.test.ts
```

The live test makes six single-attempt requests for each model. Tests make no
live requests without `SEDUM_CLEF_LIVE=1`; normal CLI use calls the selected
provider when a model decision is needed.
