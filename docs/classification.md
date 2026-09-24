# Step classification

Each YAML string step becomes one operation before the browser runs it. The classifier accepts `click`, `type`, `press`, `goto`, `verify`, `measure`, `scroll`, `wait`, and `remember ... as {{name}}`. A `use:` module entry is not a sentence; it is resolved as a module call rather than classified. Classification chooses the operation only; the locator, executor, and assertion engine do their own work.

The core API takes `{ sentence, source: { file, line, col, moduleStack? } }` items and returns one classified result or diagnostic per item. It keeps the original sentence and source location. `classifyParsedFlow(parseFlow(...), options)` connects the YAML parser to classification, preserves phase and parser positions, collects recoverable parse and classification errors from the same file, and updates step coverage. `sedum run` and `sedum validate` use that result. Any diagnostic blocks execution of that step. A line requesting multiple actions must be split. An unsupported action is an error rather than a guessed click.

## Decision order

1. Reject empty, known unsupported, or explicit multiple-action text.
2. Apply conservative leading-verb rules. A `remember` rule requires a final `as {{name}}`. A `goto` rule requires an explicit http(s) address. A wait requires a positive duration of at most 30 seconds. A type value can be `{{key}}` or a quoted expression containing placeholders, such as `"{{user}}@example.com"`.
3. Read a model answer from `.sedum/classifications.json`, if present and compatible.
4. In online mode, send unresolved unique sentences as independent TypeSafe Choices in one request for an ordinary file. Long files split at the 64 KiB serialized request bound. Choices include `unsupported_or_unclear` and `multiple_actions` so the model can refuse an unsafe operation.

A model operation is accepted only with a coherent complete probability distribution, selected probability at least 0.80, and a top-two margin at least 0.15. These are provisional decision thresholds, not a calibration claim. Pattern results carry `probability: null`; model and cache results carry the selected probability. The response records TypeSafe model/version, calls, attempts, tokens, cost, and duration separately from locator and judge work. A later chunk failure retains earlier receipts and failed-attempt counts; unknown total cost stays `null`.

## Offline validation and CI

The `offline` classification mode uses patterns and the committed cache. It makes no provider call, needs no API key, and does not write the cache. For each unresolved sentence it reports `file:line:col`, the exact original sentence, the cache miss reason, and a fix. It collects all such errors in a file. `sedum validate` uses offline mode by default; `sedum validate --online` is the explicit path to populate the cache (see [CLI commands](cli.md)). CI reads the committed cache without writing it.

## Classification cache

`.sedum/classifications.json` is a project file intended to be committed. It is separate from the local locator cache in worktree Git metadata. It stores **model answers only**, with stable ordering and atomic writes. The key is SHA-256 of a domain prefix plus the NFC-normalized, whitespace-collapsed sentence. Case, quotes, and literal placeholders are preserved. The key omits test identity, page, URL, and substituted data values. Each entry stores operation, full probabilities, model, requested model, and prompt, operation-set, and acceptance-policy versions. Pattern answers recompute and take precedence over cached model answers.

Incompatible, invalid, or newly ambiguous entries are misses. A changed threshold requires an acceptance-policy version bump, and the current gate is reapplied on cache reads. To clear classifications, remove `.sedum/classifications.json` and run the explicit online classification path again. Sentence hashes are not secret protection; short sentences can be guessed. Test data placeholders are never substituted before classification, but a quoted literal written directly into a test sentence is sent to the provider as written. Do not put secrets directly in test sentences.

`remember` classification only identifies a read/bind step. Validation recognizes `remember ... as {{name}}` and `capture ... as {{name}}` as binding forms, allows later references, and rejects names already used by data or an earlier binding. A `capture` form still needs an accepted model classification before validation succeeds. At run time, a `remember` step reads from the page's readable targets, rejects an empty or overlong read, stores the raw page value, and substitutes it literally into later claims. Declared data values stay out of model requests.

## Cost probe

After `pnpm build`, run `node evals/classification-cost.mjs`. It prints cold and repeated counts, tokens, cost, and latency for a three-step file. By default it uses a recorded fixture receipt: the cold pass makes one classification request for `capture ... as {{item}}` (120 input tokens, 5 output tokens, $0.00000504 in the fixture), while the repeated offline pass makes zero requests. This verifies accounting and cache behavior, not current model pricing or classification accuracy. With a `TYPESAFE_API_KEY`, `node evals/classification-cost.mjs --live` makes an actual TypeSafe request and reports its returned usage and cost.
