---
title: "Goal-based tests"
---

Goal tests are written in YAML. Use `goal` and an independent `verify` claim
instead of a `steps` list:

```yaml
url: https://www.saucedemo.com/
data:
  username: standard_user
  password: $SAUCE_PASSWORD
  first_name: Ada
  last_name: Lovelace
  postcode: "94016"
goal: >
  Sign in with {{username}} and {{password}}, select a Sauce Labs Backpack,
  and complete checkout using the supplied customer details.
verify: Thank you for your order! is visible
```

Save as `checkout.test.yaml`, then use `sedum validate checkout.test.yaml` and
`sedum run checkout.test.yaml`. Validation checks syntax and declared bindings;
it does not predict whether a goal can be achieved. Both `goal` and `verify`
must be nonblank strings; mixing them with `steps` is invalid. Module files
remain authored steps. Existing `before`/`after` hooks and module calls work:
failed setup skips the goal, and teardown runs after ordinary goal failures.

With the TypeSafe provider, goals can automatically generate synthetic data
with Faker when no applicable supplied or remembered value exists. No profile
or `generate` declaration is needed. Environment-derived values remain opaque.
A goal must earn an unflagged
independent verification pass using configured assertion thresholds. The
planner's DONE is never itself a passing verdict. Goal execution retains
24-request, 18-action and 120-second defaults; global CLI cancellation also
applies. YAML does not expose gate or budget overrides. Automatic whole-test
`--retries` do not restart failed goal tests.

HTML reports show the full, secret-redacted **Goal** and **Verify** above the
replay and action list. Step-based reports have no goal section.
Reports list each dispatched click or type action, followed by a `goal`
verification step with action/request counts, failure reason and Judge scores.
Typed values appear as binding names such as `{{password}}`, never resolved
values. Run with `--replay` to inspect post-action frames in the HTML player;
sensitive pages remain excluded. Replay is a visual review of the recorded run,
not a re-execution of its actions. Planner/Judge usage is counted only once.
The underlying API remains `runGoal(page, planner, judge, options)` with
`TypeSafeAdapter.chooseGoal` and `chooseGoalValue`. Authored-step execution is unchanged.

## Automatic data proof of concept

```yaml
url: /signup
goal: Create a new test account and complete its profile.
verify: The profile was saved successfully.
```

For each fill, Jev first chooses a field, then makes a second bounded Choice
among supplied bindings, remembered generated bindings, 180 local Faker
generators, and `BLOCKED`. Both requests count against the goal budget. Faker
executes locally; there is no text-generation model or model-authored code.
Supplied binding names are visible to the operation planner, including when
their values are secret. Custom planners without `chooseGoalValue` retain the
original supplied-binding-only behavior.

Generated values live for one goal invocation. Each gets a stable binding ID,
generator identity, original field/page context, and successful-use context.
Confirmation fields and later pages can reuse that ID; a different entity can
select a new value from the same generator. Values stay opaque in model inputs
and report text; screenshots/video are not masked. A field already containing
known data is omitted from fill choices. A provably pre-dispatch stale retry
retains its selected value. Unknown dispatch outcomes stop the goal.

The TypeScript `runGoal` options accept `dataSeed`, returned on `GoalResult`;
otherwise the runner chooses a random seed. The POC uses English/base locale
data and pinned Faker 10.6.0. Reproduction also requires the same sequence of
generator choices. YAML needs no new syntax and does not yet expose a seed.

Limitations: applicable-value selection and refusing to fabricate existing
credentials are model instructions, not a security guarantee. Use disposable
test environments. The catalog excludes arbitrary helpers, payment credentials,
structured results, and date methods needing formatting/reference dates. Email
generation uses reserved example domains. Independently generated attributes
do not yet form a coherent person/address; uniqueness is not guaranteed.
Native constraints and length limits are checked before filling, but custom
application validation is not inferred. Constraint mismatch stops the goal;
there is no regeneration loop or automatic correction of already-filled data.
The complete value-choice list (catalog + bindings + BLOCKED) must fit 255
options and the existing provider request-size bound.

Reproduce the live local experiment with Node 22.18+ and `TYPESAFE_API_KEY`
available in the environment:

```sh
pnpm build
node scripts/goal-faker-experiment.ts
```

The script starts and closes a disposable fixture server and fresh browser
contexts. It writes timestamped JSON receipts and screenshots under
`.amp/in/artifacts/goal-faker`; it makes paid Jev calls, never contacts a real
signup service, and does not retry failed goals until they pass.

Two initial live runs on 2026-09-30 used `jev-1.13.0`. Both made the six correct
value-source choices: first name, account email, reuse for confirmation,
biography, a new recipient email, and reuse of the account email on a second
page. Both dispatched 8 actions in 16 requests and passed every exact DOM/data
check. **Both remained failed goals** because the independent Judge rejected
the visible confirmation; no gates were relaxed. Missing-credentials controls
typed nothing: one operation abstention and one explicit value `BLOCKED`.
The first experiment used Bun and encountered a fixture-server shutdown error
after saving its receipts; the documented Node invocation exited normally.
These are feasibility observations, not a reliability estimate.

### Judge investigation: explicit message claims

Capturing the actual Judge input ruled out missing/stale confirmation text and
redaction in this fixture: the complete digest was exactly
`Add a different recipient Profile saved`. The SDK Noul signature and response
polarity were correct. On the same evidence, the original claim
`Profile saved is visible` scored holds=0.29; `"Profile saved" is visible`
scored 0.81; `The page displays the confirmation message "Profile saved".`
scored 0.90. Moving the claim into question instructions, removing criteria,
adding line breaks, or adding heading/status labels did not fix the original
claim. This isolates wording sensitivity, not a proven account of the model's
internal interpretation.

The demo now uses the explicit confirmation-message claim. A fresh recorded
run passed all exact DOM checks and independent verification (holds=0.91,
contradicted=0.06, no flags), with the same 8 actions and 16 requests. The
missing-credentials control returned BLOCKED with no actions. Generation,
page extraction, shared Judge prompts, and all thresholds are unchanged.
The receipts now include the actual redacted claim, digest, and Judge response.

Quote literal UI text and state what it is: for example,
`The page displays the confirmation message "Profile saved".` rather than
`Profile saved is visible`. This is authoring guidance, not an automatic
rewrite or a guarantee: another quoted claim, `"Order placed" is visible`,
still scored only 0.71 in the fixed-evidence comparison.

The six live confirmation regressions passed: actual confirmation, negation,
button-only evidence, unrelated success, hypothetical text, and page-injected
instructions. Positive cases must earn an unflagged pass under the existing
policy; negative cases must not. These narrow cases do not establish broad
semantic accuracy or coherent generated identities.

```sh
# Paid fixed-evidence comparisons; all outcomes retained, including failures:
node scripts/judge-experiment.ts
node scripts/judge-experiment.ts --boundaries
# Paid opt-in semantic regression checks:
SEDUM_TYPESAFE_LIVE=1 pnpm exec vitest run packages/provider-typesafe/src/index.live.test.ts
# Record the clarified assertion, or reproduce the original rejection:
node scripts/goal-faker-experiment.ts --demo
node scripts/goal-faker-experiment.ts --ambiguous-claim
```

## Decision and execution boundaries

The design follows `model.py` (`action_space`, `choose`), `agent.py`, and
`questions.py` in [jev-ultrafast at the inspected revision](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46):

1. Observe Sedum's complete digest and click/fill candidates.
2. Offer `CLICK`, `TYPE`, `DONE`, and `BLOCKED`; omit unavailable operations.
   `TYPE` chooses an observed field when automatic data is supported; otherwise
   it chooses a field/supplied-binding pair. No generative text model,
   model-authored selectors, JavaScript, coordinates, or URLs.
3. Ask the operation question and speculative operation-specific target
   questions in **one** System One request. Shared state includes the offered
   targets, redacted page digest, and ten recent actions.
4. Validate the operation and **only its selected target head** using the
   provider's existing exact-key, probability-sum and argmax validation.
   Apply the strict locator's confidence floor 0.3 and default lead floor 0.1.
   Experimental `operationMinMargin` changes only the operation lead floor;
   target gates and independent verification remain unchanged.
   Automatic fills then make a value-source request with the same confidence
   and margin gates, before the freshness checks and dispatch below.
5. Sedum has one operation-specific snapshot, so recollect the chosen operation
   and require the exact page version and whole candidate surface to match. If
   either changed before dispatch, discard the decision and re-observe; never
   remap or dispatch the stale choice. A pending generated value is reused only
   when its complete redacted page/field observation is unchanged. Remap the
   private reference only after an exact match, then execute through `executeStep`.
6. Record before dispatch. A target that went stale before dispatch provably
   received no input: it is taken back, not reported as an action, and the
   page is observed again (each retry still costs a planner request). Stop on
   every other executor error; an uncertain dispatched action is never
   replayed.
7. `DONE` calls the existing independent assertion engine with separately
   authored claims. The runner requires **unflagged** passes: stricter than authored
   steps' normal passed-with-warning policy. `DONE` alone cannot pass.

`resolveData` and `RuntimeValue` keep environment-derived values opaque.
Known secret echoes are redacted from goals, candidates, page text, history,
and verification reports. A host-authored browser read compares field values
locally and returns only occupancy/binding matches. This is not a guarantee
against unknown secrets in arbitrary authenticated pages; use fresh contexts
and disposable data. Video is opt-in and is not automatically privacy-masked.

Default budgets: 24 decision/assertion reservations, 18 dispatched actions,
120 seconds; hard maxima 64/48/300 seconds. Goal calls disable HTTP retries,
including independent Judge calls. More than three visits to the same
page/digest/field-binding state stops as `no_progress`. Low confidence,
abstention, oversized/incomplete observations and stale targets fail closed.
An abstention reports which decision was uncertain, on which page, and its top
probabilities, for example `operation on /checkout-step-one.html: CLICK 0.41,
TYPE 0.33, BLOCKED 0.17`. Name that page or control in the goal, or move that
part into authored steps. `BLOCKED` means no offered element or field can move
the goal forward; every step the goal names, such as signing in or placing an
order, is treated as expected. Stale and blocked goal summaries retain safe
page evidence and target metadata when reporting is enabled. Their explanation
names the changed page/target boundary and, for generated data, the selected
Faker generator, but never the generated value.
Timeouts with unknown provider usage retain unknown cost rather than zero cost.
Custom provider implementations must honor cancellation and `maxAttempts: 1`.

## Reproduce the bounded experiments

Build the workspace with `pnpm build`. Provide `TYPESAFE_API_KEY` through the
environment, never command-line arguments. The model is explicitly `jev-latest`.
The local app is the existing `fixtures/site/server.ts`, and data is loaded from
`fixtures/ui-login-checkout.test.yaml` and `fixtures/saucedemo-checkout.test.yaml`.

```sh
amp orb service start goal-fixture --command 'bun scripts/goal-experiments.ts serve' --port 4174 --portal
bun scripts/goal-experiments.ts local
bun scripts/goal-experiments.ts sauce
bun scripts/goal-experiments.ts public
# Optional single run, deliberately slowed for a legible continuous video:
bun scripts/goal-experiments.ts local fixture-checkout --demo
```

Each invocation is finite; these commands make paid calls and are not part of
`pnpm test`. Public experiments use fresh contexts, nonpersonal query data,
and host-authored click-name allowlists for browsing/search only. Allowlists
constrain these specific tests; they are not a general security sandbox.
The harness writes per-run JSON receipts and genuine Playwright WebM videos
under `.amp/in/artifacts/goal-mode`. `--demo` adds 150 ms browser slow motion
and 750 ms real-time dwell before each decision; timings include those delays.

## Observed results, 2026-09-29

All responses reported **jev-1.13.0** for requested **jev-latest**. Times below
exclude initial browser launch/navigation; request counts include verification.
Every listed request made one HTTP attempt. Costs use Sedum's existing estimate
of $0.042/million input tokens and zero output-token cost, not billing invoices.

| Task/run                                                       | Outcome                                                     | Actions/requests | Seconds | Input/output tokens | Estimated USD |
| -------------------------------------------------------------- | ----------------------------------------------------------- | ---------------: | ------: | ------------------: | ------------: |
| Local: sign in, exactly one Canvas Backpack, checkout          | Pass; Judge + exact cart/form/confirmation checks           |            10/12 |   2.505 |        21,948/1,726 |   0.000921816 |
| Local: same task with two-action budget                        | Expected `action_limit` failure                             |              2/3 |   0.560 |           5,529/478 |   0.000232218 |
| Local: observe Sign in, but independently require Order placed | `DONE` rejected by independent verification                 |              0/2 |   0.427 |           2,239/207 |   0.000094038 |
| Sauce Demo: Backpack + Onesie checkout                         | `BLOCKED`, no action                                        |              0/1 |   0.407 |           1,909/170 |   0.000080178 |
| Books to Scrape: Travel → It's Only the Himalayas              | Pass; Judge + exact URL/heading                             |              2/4 |   2.123 |           4,798/263 |   0.000201516 |
| Quotes to Scrape: Einstein biography                           | Pass; Judge + exact URL/author                              |              1/3 |   1.148 |           4,624/208 |   0.000194208 |
| Wikipedia: search Sedum → article                              | Article URL/heading correct; run fails on incomplete digest |              2/2 |   2.952 |           2,421/159 |   0.000101682 |
| Inspected continuous local demo                                | Exact cart/form checks pass; Judge low-confidence failure   |            10/12 |  12.360 |        21,948/1,726 |   0.000921816 |

The inspected demo ends at `Order placed`, but the Judge returned holds=0.68,
contradicted=0.07, with `low_confidence`. The run remains failed. A preceding
150-ms slow-motion recording had the same outcome in 4.147 seconds. Neither was
rerun until passing or relabelled as a verified success.

All development failures are retained: four invalid-response attempts from
reversed SDK `choice()` arguments; three abstentions before offered targets
were added to shared state; and a negative-test variant that abstained after
sign-in rather than requesting verification. Across **17 runs**, including
those failures and demo captures: **62 requests, 40 actions, 102,913 input /
8,005 output tokens, estimated $0.004322346**. These are exploratory cases,
not a success-rate estimate or a comparison with authored steps/jev-ultrafast.

## Operation-margin experiment, 2026-09-29

Four alternating fresh-context Sauce Demo runs compared the default operation
margin 0.1 against 0.03, two each. Goal: `Sign in with username: {{username}} and
password: {{password}} and complete the checkout flow`. Supplied bindings used
the existing demo fixture. Verify: `The checkout is complete: Thank you for
your order! is visible and the order has been dispatched message is shown`.
DOM, customer-data, summary and ordered-route checks were unchanged.

Reproduce one lower-margin run with:

```sh
bun scripts/goal-experiments.ts sauce saucedemo-checkout --credentials --demo --lower-operation-margin
```

| Margin | Seconds | Final choice | Confidence | Lead | Result               |
| ------ | ------: | ------------ | ---------: | ---: | -------------------- |
| 0.1    |   4.346 | CLICK        |       0.25 | 0.01 | operation_abstention |
| 0.03   |   4.383 | BLOCKED      |       0.28 | 0.05 | operation_abstention |
| 0.1    |   4.334 | BLOCKED      |       0.24 | 0.01 | operation_abstention |
| 0.03   |   4.397 | BLOCKED      |       0.26 | 0.02 | operation_abstention |

Each run signed in (3 actions, 4 requests) then stopped on Products. Each used
9,082 input tokens and estimated $0.000381444; output tokens were 795 for the
first run and 797 for each other run. Actual model: `jev-1.13.0`. All independent
outcome checks failed; no DONE/Judge verification was reached. Both representative
baseline/lower-margin continuous recordings were inspected. Reports now retain
validated choice IDs, probabilities and confidence, without binding values.

Lowering margin alone did not improve these runs. All final confidences were
below 0.3. Accepting BLOCKED at a lower confidence would still terminate, not
dispatch CLICK. This small comparison does not establish general reliability;
prompt interpretation/product selection needs investigation before more gate
relaxation. Defaults remain unchanged.

### Allowing any product

Two fresh runs added only `You may select any product.` to the explicit-bindings
goal above, retaining the default 0.1 margin, 0.3 confidence floor, data and
verification. Reproduce with `bun scripts/goal-experiments.ts sauce
saucedemo-checkout --any-product --demo`.

The first completed checkout with one Sauce Labs Backpack: 11 actions,
18 requests, 18.588 seconds, 43,418 input / 3,362 output tokens, estimated
$0.001823556. Judge holds=0.97, contradicted=0.03, no flags; DOM confirmation,
customer data, summary and ordered-route checks all passed. The second stopped
before login: TYPE=0.54 versus BLOCKED=0.45, confidence=0.38, rejected by the
0.1 margin. It used 0 actions, 1 request, 0.928 seconds, 1,861 input / 168 output
tokens, estimated $0.000078162; no Judge check was reached. Both used
`jev-1.13.0`; both continuous videos were inspected and both reports retained.
This demonstrates a successful full flow, not reliable completion.

### Python implementation context experiments

Six fresh sessions tested three additions separately, in order data,
instructions, completion, then the same order again. Goal, supplied values,
verification and gates stayed identical to the any-product experiment above.
Use `--any-product --demo --context=data` (or `instructions`, `completion`).
Reports record `contextVariant`; baseline requests omit all optional fields.

1. `data`: persistent sorted declared binding keys, no values.
2. `instructions`: operation-only guidance to use field matches/history, avoid
   already satisfied steps, fill required fields before submitting, and define
   BLOCKED as no available operation making progress. Target rules unchanged.
3. `completion`: the existing verification claim is visible in planner state.
   No speculative stop head was added; DONE still invokes the separate Judge.

| Variant      | Results  | Seconds (runs 1 / 2) | Input/output tokens per run | Estimated USD per run |
| ------------ | -------- | -------------------- | --------------------------- | --------------------- |
| data         | 2 passed | 18.472 / 18.529      | 43,945 / 3,361              | 0.001845690           |
| instructions | 2 passed | 18.316 / 18.390      | 44,319 / 3,361              | 0.001861398           |
| completion   | 2 passed | 18.570 / 18.504      | 43,996 / 3,362              | 0.001847832           |

All used `jev-1.13.0`, 11 actions and 18 requests each, selected one Backpack,
passed DOM/customer/summary/route checks and independent Judge holds=0.97,
contradicted=0.03 with no flags. Timings include demo pauses. Total estimated
cost: $0.01110984. One continuous video per variant was inspected; all six
recordings and reports were retained. No failures occurred in these six runs;
earlier baseline failures remain retained rather than replaced.

Richer instructions had the strongest initial TYPE probabilities (0.87–0.88,
confidence 0.82–0.83), versus 0.57–0.63 for data and 0.57–0.65 for completion.
Two repeats per variant, without a contemporaneous baseline or combined variant,
do not establish causal improvement or production reliability. No defaults or
authored-step behavior changed.

### Short goal with all three additions

Two fresh runs used exactly `Sign in and complete checkout` with persistent
data keys, richer operation instructions, and visible completion criteria
together. No any-product permission was added. Supplied data and verification
stayed unchanged, with the original confidence 0.3 / margin 0.1 gates.
Reproduce with `bun scripts/goal-experiments.ts sauce saucedemo-checkout
--short-goal --context=all --demo`.

Both logged in then stopped on Products without adding an item. Run 1 failed
with operation_abstention (BLOCKED=0.51, CLICK=0.48, confidence=0.28); run 2
returned blocked (BLOCKED=0.60, CLICK=0.40, confidence=0.39). Each dispatched
3 actions over 5 requests, using 12,674 input / 1,061 output tokens on
`jev-1.13.0`, estimated $0.000532308 each. Times were 5.198 and 5.386 seconds
including demo delays. Neither reached DONE or the Judge; independent outcome
checks failed. Both continuous videos were inspected and retained. These
additions alone did not resolve the short goal in this two-run experiment.

## Verification and limitations

Unit tests cover wire criteria (not only response shape), selected-head-only
validation, confidence gates, false/flagged `DONE`, budgets, no progress,
redaction, changed candidate identities, and uncertain-dispatch termination.
The browser-backed goal test reuses the existing checkout and production
executor. The recorded-reply fixture suite protects authored-step behavior.
Offline tests must run with provider credentials **unset**, e.g.:

```sh
env -u TYPESAFE_API_KEY -u TYPESAFE_BASE_URL -u TYPESAFE_DEFAULT_MODEL pnpm test
pnpm typecheck
pnpm fixtures:verify
SEDUM_BROWSER_INTEGRATION=1 pnpm exec vitest run packages/core/src/goal-runner.integration.test.ts
```

No general select/scroll/wait support,
semantic freshness optimization, broad real-site coverage, or production
security claim is included. The 4,096-character complete-digest requirement
blocks long pages such as the reached Wikipedia article. Model abstention and
Judge variability remain visible failures. No changes from the independent
browser-profiling or semantic-freshness orbs were imported.
