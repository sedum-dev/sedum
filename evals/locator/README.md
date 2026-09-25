# Locator eval

Measures how reliably Sedum turns a step sentence into the right page element,
and which layer fails when it does not. Each case is a frozen page, a sentence,
and the element a person would expect.

```sh
corepack pnpm build
corepack pnpm eval:locator                       # key-free lexical baseline
corepack pnpm eval:locator --resolver typesafe   # TypeSafe; needs TYPESAFE_API_KEY
corepack pnpm eval:locator --resolver typesafe --offline   # replay recorded replies only
corepack pnpm eval:locator --tag ordinal -v      # one tag, with ranked candidates
corepack pnpm eval:locator --validate            # check cases and labels only
```

Every run first validates the cases: each gold id must be marked exactly once
in its page, case ids must be unique, and each case needs an operation,
sentence, and tag. Each run prints a summary and writes full results to
`results/` (ignored by Git).

## Cases

`pages/*.html` are self-contained pages served from a local server. Mark each
element a case may target with `data-eval-gold="<id>"`. Labels live in the page
rather than in a selector or run-local ref, so they survive extractor changes.

`cases/<page>.json` lists sentences for one page:

```json
{
  "page": "shop-grid.html",
  "cases": [
    {
      "id": "shop-add-light",
      "op": "click",
      "sentence": "click the Add to cart button for Trail Light",
      "gold": ["add-light"],
      "tags": ["repeated-group", "container"]
    }
  ]
}
```

- `op` is the locator operation: `click`, `fill`, or `read`.
- `gold` is a list of acceptable ids, `"none"` when the target is not on the
  page, or `"ambiguous"` when a person could not tell which element is meant.
  Giving up is correct only for the last two. List several ids when either
  click is equally correct, such as two Home links to the same address.
  A sentence that precisely names a disabled control has that control as its
  gold: finding it is the locator's job, and refusing it is the action's.
- `tags` name the difficulty, so results break down by failure type.

Write sentences the way a test author would, including paraphrases, ordinals,
and scoping to a row or region. Include negatives: an eval without `none` and
`ambiguous` cases cannot measure wrong actions.

## Metrics

Every case lands in one outcome:

| Gold                | Acts on a gold element | Acts on anything else | Gives up          |
| ------------------- | ---------------------- | --------------------- | ----------------- |
| element ids         | `correct`              | `wrong_action`        | `false_reject`    |
| `none`, `ambiguous` | n/a                    | `wrong_action`        | `correct_abstain` |

The headline numbers are the **wrong-action rate** (a wrong click or fill; the
most harmful outcome) and the **success rate** on answerable cases.

Each failure is also attributed to a stage:

- `recall`: the gold element was never offered to the model. Fix extraction.
- `rank`: it was offered, but the model preferred another option.
- `gate`: the model preferred it, but the confidence gate rejected it.
- `operational:<reason>`: stale page, provider error, request too large, and
  similar.

`indistinguishable` marks a gold element whose projection (tag, role, name,
peers) is identical to another option's, so no model could tell them apart.

## Resolvers

- `lexical` scores word overlap between the sentence and each candidate. It
  needs no key and is a floor, not a target.
- `typesafe` calls the configured TypeSafe model through the production
  adapter. Replies are cached in `replies/<model>.json`, keyed by the sentence
  and candidate projections with run-local ids replaced by position, so reruns
  and threshold experiments cost nothing. Commit the reply file with new cases
  so anyone can replay a run with `--offline`.
