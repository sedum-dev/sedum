# Sentence-cache benchmark

Compares warm locator-cache coverage, model calls, cost, and time across built
Sedum checkouts, using the SauceDemo sentence checkout in `fixture/`. The
fixture is byte-identical to the one used in the original sentence-cache study.
`benchmark.mjs` refuses to run if its SHA-256 differs.

```sh
# One built checkout per variant (pnpm install && pnpm build in each).
git worktree add ../bench/stock <base>
git worktree add ../bench/change <commit>

# Live provider and public-site run. Credentials come from the environment
# (for example TYPESAFE_API_KEY); never pass them as arguments.
node evals/sentence-cache/benchmark.mjs --out <new dir> --pairs 6 \
  --variant stock=../bench/stock --variant change=../bench/change
node evals/sentence-cache/summarize.mjs <new dir>

# Local admission and matching cost only: no browser, model or network.
node evals/sentence-cache/local-overhead.mjs stock=../bench/stock change=../bench/change
```

Every pair gets a fresh fixture copy with its own Git metadata, so each pair
has its own cache. Cold and warm runs are separate CLI processes with fresh
browser contexts. Variant order rotates from pair to pair. The harness refuses
an existing evidence directory, requires exactly one `result.json` with a new
run ID per process, and records infrastructure failures separately from failed
tests. After each cold run it reads the plaintext `boundedContext` flag of each
step's recipe to report the admission path (`bounded`, `other`, or
`not_stored`).

`summarize.mjs` reports medians with min–max ranges. With six pairs, treat
time differences smaller than that spread as noise. A cache hit means the
target matched; it does not verify the action's effect.
