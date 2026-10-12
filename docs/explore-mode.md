---
title: "Exploration mode (proof of concept)"
---

`sedum explore <url>` explores a site on its own. It takes a seeded, weighted
random walk over the same candidate scanner that `sedum run` uses, guided by
Jev. It watches three oracles: console errors, uncaught page exceptions and
same-origin HTTP 5xx responses. With `--shrink`, it turns each failure into a
short plain-English test you can commit.

```sh
sedum explore https://staging.example.com/ --steps 200 --seed 7
sedum explore https://staging.example.com/ --mode random --shrink
sedum explore --replay .sedum/explore/<run>/trace.jsonl
```

This is a proof of concept. Use it only against disposable environments: it
clicks real buttons, and its safety check is a model's judgement, not a
guarantee.

## How a step works

1. **Observe.** Sedum waits for the page to settle (DOM quiet), then reads
   the visible text and every click and fill candidate from the page script.
   A state is identified by its route plus its visible text.
2. **Build the action tree.** The tree has clicks (100 in total, split across
   targets), typing (50), pressing Enter (10), scrolling (5), going back (10),
   reloading (1) and waiting (1). These are Bombadil's defaults, adjusted for
   Sedum. Links that leave the start URL's origin are removed. If an action
   still leaves the origin, the walk is forced back.
3. **Guide (guided mode).** One TypeSafe request per new state asks:
   - a `choice`: which kind of page this is (home, listing, detail, search,
     form, confirmation, auth, account, admin, cart, content, error, other);
   - per click target, a `noul`: "would activating it perform a destructive or
     irreversible action?";
   - per click target, a speculative `choice`: which kind of page it most
     likely leads to.

   Answers are cached per state. Targets at or above 0.6 destructive
   probability are skipped, and the rest are weighted by (1 − p)². Clicks are
   weighted towards destinations not yet taken whose page kind has been seen
   least. The observed kind is used once known; before that, Jev's prediction
   stands in. On pages Jev calls a form or search, typing gets more weight,
   and Enter gets more weight as fields fill.

   Those pages also offer a planned "fill this form" action (weight 40). It
   types a valid Faker value into every field, then presses Enter. A random
   walk almost never completes a form on its own, because it has to fill
   every field correctly and then submit, without wandering off. Each part of
   the plan runs as its own step and is recorded as an ordinary action, so
   replay and shrinking treat it like any other. Finally, 20% of every pick
   comes from the unguided weights over the safe actions, so the walk never
   fully trusts the model.

4. **Choose a value.** A guided fill uses a Faker generator 60% of the time.
   The generator is picked by goal mode's closed choice among about 180 local
   generators, asked once per field. 25% of fills use hostile text
   (bidi overrides, zero-width joiners, combining marks, emoji, injection
   strings) and 15% use Bombadil-style random text.
5. **Act and record.** The target is collected again and found by identity
   (role, name, location, peer text, occurrence) before Sedum's step executor
   dispatches it. Each action is appended to `trace.jsonl` with its route,
   state, page kind, the weights behind the choice and any oracle events.

`--mode heuristic` runs the same walk without a model. Safety comes from a
keyword list, coverage from untried destinations, and values from Faker by
input type. It exists as an ablation. `--mode random` is the blind walk.

## Oracles

The walk always reports console errors, uncaught page exceptions, HTTP 5xx
responses from the start origin, and broken links: page navigations answered
with 4xx or 5xx. These options adjust that:

- `--watch-origin <origin>` also watches another origin, such as a separate
  API host. Repeat it for more origins.
- `--rejected-submits` also reports a 4xx answer to a submission (any method
  except GET or HEAD; 401, 403 and 404 are excluded). Such an answer means the
  UI let the user send something the server refuses. It is opt-in because some
  apps rely on server-side validation on purpose.
- `--ignore-console <regex>` ignores known console noise, such as a
  third-party player's permissions-policy warning. Repeat it for more patterns.

After each action, the walk waits for the DOM to go quiet and for no request
to have been in flight for 300 ms (at most 3 s). Single-page apps fetch route
code and data after the DOM settles.

Each trace entry also lists the successful writes the action caused: every
non-GET request to a watched origin, where a GraphQL request counts only when
it carries a mutation. The summary totals writes per endpoint, so you can
audit what an exploration changed.

## Exploring a real staging account

- `--cookies <storage-state.json>` signs the browser in with the cookies of a
  Playwright storage-state file. Log in with a separate script, so the
  exploration never types or records credentials.
- `--strict-safety` skips a target when either Jev or the destructive keyword
  list (delete, remove, send, invite, share, archive, log out…) says so. Jev
  judges a confirming button (Yes, OK, Proceed) by what it confirms, and
  counts imports, syncs, integrations and signing out as irreversible. Once a
  target is judged destructive anywhere, it stays skipped for the rest of the
  walk.
- A step still running after 60 s restarts the walk from the start page, and
  the walk stops when it keeps leaving the site, for example after the
  session expires.
- The walk can still create data through ordinary forms. Use an organization
  or account you can reset, and review the write log after each run.

Two adjustments help on large apps. A non-link target seen on three or more
paths, such as a navigation bar built from buttons, shares one destination,
so it stops looking new on every page. After a click the page refuses (for
example, one covered by an open panel), the walk offers Escape, and each
refusal halves that target's weight everywhere it appears.

## Reproduce, replay and shrink

- `--seed` makes the choices of a random or heuristic walk repeat exactly.
  A guided walk repeats as long as Jev's answers do.
- `--replay trace.jsonl` re-runs the recorded actions. Every action kind is
  matched by identity, including reload, which Bombadil's replay cannot match.
  Typed values are stored, so a replay does not depend on the seed.
- `--shrink` cuts each failing trace with delta debugging (complement removal,
  up to 48 replays in fresh browser contexts) to the shortest list that shows
  the same failure signature. It then writes the list as a YAML test:
  - Clicks and fills become `click the "Export CSV" button` and
    `type {{value1}} into the "Search products" field`. When the plain
    sentence is ambiguous, the item or section is added.
  - Each sentence is resolved through Sedum's locator before it acts, and is
    kept only if it lands on the recorded element.
  - Back and reload become `goto` the URL they reached.
  - When the failing page shows an error line, the test ends with a
    deterministic `verify the text "..." is not shown`. Otherwise a comment
    explains that Sedum has no sentence for console or network errors yet.

## Limitations

- Safety is advisory. Jev's confidence is not calibrated per answer, and
  page text can try to steer it. Exploring a real account still needs a
  disposable environment.
- Shrinking replays against the same server. Destructive or stateful
  actions can change what a replay sees.
- The page-kind list is generic. Kinds that are too coarse for a site (for
  example, every settings page is "account") make coverage guidance weaker.
- Jev reads text only, and page text is cut to 3,000 characters per request,
  with at most 60 click targets.
- The provider is TypeSafe only, configured from `TYPESAFE_API_KEY`. The
  command does not read `sedum.config.yaml`.

## Evaluation on the fixture shop

`fixtures/site/explore-site.ts` is a small shop with:

- 48 product pages that link to each other;
- pages reachable only through a sequence of actions (a reports page, an
  admin console revealed by a preference checkbox, and a newsletter welcome
  page behind form validation);
- four planted bugs: a crash on non-ASCII search text, a console error after a
  valid newsletter signup, an HTTP 500 on CSV export, and a console error in
  the admin console;
- four destructive buttons, one of them worded without any destructive
  keyword ("Start over with an empty account");
- a benign button worded like a destructive one ("Remove all filters");
- an off-origin link.

```sh
pnpm build
node scripts/explore-experiment.ts --seeds 8 --steps 100
```

Results from 2026-10-11, with `jev-1.13.0`, 8 seeds × 100 steps per mode.
Page kinds were measured with the same Jev question in every mode, but only
guided mode is steered by the answers.

|                                            | random  | heuristic            | guided      |
| ------------------------------------------ | ------- | -------------------- | ----------- |
| Distinct states (mean)                     | 22.3    | 35.4                 | 32.5        |
| Route templates (mean)                     | 11.3    | 15.5                 | 15.3        |
| Page kinds (mean)                          | 7.0     | 8.3                  | 8.5         |
| Hidden pages, of 4 (mean)                  | 0.1     | 1.9                  | 1.9         |
| Planted bugs found per run (mean)          | 0.5     | 1.5                  | 2.0         |
| Distinct planted bugs over all seeds       | 1       | 2                    | 4           |
| Destructive actions (total; runs affected) | 14; 7/8 | 7; 4/8               | 0; 0/8      |
| Benign buttons skipped as destructive      | none    | "Remove all filters" | none        |
| Jev calls per run (mean)                   | –       | –                    | 36.5        |
| Input tokens per run (mean)                | –       | –                    | 164k        |
| Cost per run (mean)                        | –       | –                    | $0.0069     |
| Jev latency (p50 / p95)                    | –       | –                    | 95 / 126 ms |

These are feasibility numbers on one synthetic site, not a benchmark.
