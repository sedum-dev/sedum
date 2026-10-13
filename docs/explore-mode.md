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

   Those pages also offer a planned "complete this form" action (weight 40).
   See [Completing forms](#completing-forms). Finally, 20% of every pick
   comes from the unguided weights over the safe actions, so the walk never
   fully trusts the model.

4. **Choose a value.** A guided fill uses a Faker generator 60% of the time.
   Jev picks the generator in one closed choice among about 190 local
   generators (Faker's plus Sedum's own formats), asked once per field. 25% of fills use hostile text
   (bidi overrides, zero-width joiners, combining marks, emoji, injection
   strings) and 15% use Bombadil-style random text.
5. **Act and record.** The target is collected again and found by identity
   (role, name, location, peer text, occurrence) before Sedum's step executor
   dispatches it. Each action is appended to `trace.jsonl` with its route,
   state, page kind, the weights behind the choice and any oracle events.

`--mode heuristic` runs the same walk without a model. Safety comes from a
keyword list, coverage from untried destinations, and values from Faker by
input type. It exists as an ablation. `--mode random` is the blind walk.

## Completing forms

A random walk almost never completes a form on its own. It has to fill every
field correctly and then submit without wandering off, and a wizard repeats
that on every page. So the form action is a small program, not a choice per
field. Code does the mechanics; Jev answers the questions code cannot, each
as a closed choice:

1. Read each field's state from the page: empty, invalid, required, type,
   label, placeholder, `min`, `max`, `maxlength` and `pattern`.
2. Fill every empty field. Code recognises common formats: a `pattern`
   attribute (sampled directly), day, month and year boxes, dates, UK
   postcodes, sort codes, National Insurance numbers, IBANs, account
   numbers, emails, phone numbers, numbers within their range, money
   amounts, reference codes, and first and last names. Jev picks a
   generator, Faker or one of these formats, for the rest. Passwords are
   never filled.
3. Answer each radio group that has no choice yet, native or ARIA
   (`role="radio"`), with an option Jev picks.
4. Answer each dropdown that still shows a placeholder ("Select a wrapper
   type", "Choose…", "Search for a portfolio"), with an option Jev picks:
   - a native `<select>` is chosen in one click that names the option;
   - a custom dropdown is opened, and the targets that appear are its
     options, whatever their markup;
   - a select hidden under a type-ahead widget (Tom Select, Select2) is
     chosen by typing the option into the widget's input and clicking the
     matching result.
5. Click the form's own submit button. If the form has no submit button in
   view, press Enter. If the submit button is unsafe, give up, because Enter
   would submit the form anyway. If it is disabled, give up too: something
   else must come first: see step 8.
6. Read what the submit changed. Fields marked invalid, and fields named by
   new error lines anywhere in the form (a summary box such as "Wrapper type
   is required"), are filled again, up to 3 attempts. Code matches an error
   line to a field by its label; Jev maps the lines code cannot. A refill
   uses the format the error states ("must be 6 digits"), else the field's
   format, else a generator Jev picks knowing the error. A submit that does
   nothing visible and says nothing is retried too: Jev says which fields
   holding a default 0 (a balance, but not a fee) need a real value.
7. If a new set of fields appears, treat it as the next page of a wizard (at
   most 6 pages). A page the app filled in with defaults is still submitted
   when its button continues ("Save & Continue", "Finish", "See plan").
8. If the submit (or the page's Continue button) is disabled, Jev picks the
   target that must be used first, such as "Add an account". The macro
   uses it and completes the sub-form that appears as a form of its own,
   then returns to the first form and submits it. A form opens at most two
   sub-forms, nested at most two deep. Heuristic mode picks the first "Add",
   "New" or "Create" target.

Jev judges what a form does: creates something, fills in one record,
changes settings, or searches. A form that changes settings for the whole
account, firm or team is skipped. A form that creates something is
completed even when the app pre-filled it (a new plan copies the client's
details). Any other form that is mostly filled in already edits an existing
record and is skipped. The walk can still type into either one field at a time.

These questions go through one closed-choice call, `decide`, that asks
several questions about one form or dropdown at once. Answers are cached
per form, so a form costs a call or two. Heuristic mode answers them with
rules: settings by route, options at random, errors by label.

Each part of the plan runs as its own step and is recorded as an ordinary
action, so replay and shrinking treat it like any other. A native dropdown
choice becomes `select "ISA" from the "Wrapper type" dropdown` in an
emitted test.

## Returning to unfinished pages

The walk keeps an archive of the kinds of page it has seen: a route with ids
folded (`/clients/:id`) plus the page kind. It also records how many targets
on each page it has not tried yet. After 30 steps without a new kind of page,
it returns to one that still has untried targets, weighted towards pages
visited least. To return, it loads the page's URL. If that lands on another
kind of page, the next return replays the shortest clean path (at most 15
actions) that reached the page. A path that wrote to the server is never
kept, so a return never repeats a create or a save. This is go-explore
without snapshots: Antithesis can branch from any state, and most web pages
can be restored from their URL. Random mode never returns.

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
- A guided walk stops after three Jev calls in a row fail, for example when
  the TypeSafe account runs out of credits. Carrying on would be an
  unguided walk without Jev's safety judgements.
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
  admin console revealed by a preference checkbox, a newsletter welcome
  page behind form validation, and a plan summary behind a three-page wizard
  with split date boxes, a postcode check, a radio group, an accounts step
  whose Continue button is disabled until an "Add an account" sub-form is
  saved, and number ranges);
- an "Add account" dialog without dialog roles: a custom div dropdown with a
  heading, a native select with a placeholder, a type-ahead widget over a
  hidden select, a field no format rule knows, and errors shown only in a
  summary box;
- six planted bugs: a crash on non-ASCII search text, a console error after
  a valid newsletter signup, an HTTP 500 on CSV export, a console error in
  the admin console, a console error on the plan summary, and a console
  error after saving an account;
- four destructive buttons, one of them worded without any destructive
  keyword ("Start over with an empty account");
- a single-field firm branding form, which the form macro must leave alone;
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

That table predates the plan wizard and the fifth bug.

Results from 2026-10-12: guided mode before (`107ebcc`) and after form
completion and returns, on the site with the wizard, 12 seeds × 150 steps
each, same seeds.

|                                           | before  | after   |
| ----------------------------------------- | ------- | ------- |
| Wizard completed (runs)                   | 0 / 12  | 6 / 12  |
| Plan-summary bug found (runs)             | 0 / 12  | 6 / 12  |
| The other four planted bugs found per run | 2.17    | 2.00    |
| Hidden pages, of 4 (mean)                 | 2.25    | 2.50    |
| Distinct states (mean)                    | 50.2    | 52.0    |
| Returns to an unfinished page (mean)      | –       | 1.4     |
| Destructive actions                       | 0       | 0       |
| Cost per run (mean)                       | $0.0129 | $0.0129 |

That comparison predates the "Add account" dialog and the branding form.
An integration test drives the form macro through the dialog (custom,
native and type-ahead dropdowns, then a retry from the error summary)
without a model.

These are feasibility numbers on one synthetic site, not a benchmark.
