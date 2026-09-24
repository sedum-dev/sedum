# Real site hardening log

## 2026-09-24 — Delayed labels and result timing

**Problem.** The visible Google Maps search field briefly had no associated
label after navigation, so its first fill scan returned no candidates. After
search submission, the initial map shell did not yet contain the place result;
an immediate assertion failed before the result panel loaded.

**Alternatives considered.** A site-specific selector would couple the locator
to one page. A fixed sleep in a YAML journey would either slow every run or remain
too short on a slow load. Globally retrying failed assertions could hide a
genuine failure. The fill locator now briefly rescans only when its initial
candidate set is empty. An explicit `verify eventually` step waits up to ten
seconds for changed, complete page evidence and rejudges at most five times.
Ordinary `verify` keeps its immediate semantics.

**Verification.** DevTools showed the input label arriving after the initial
scan and the Buenos Aires panel appearing after the search. A local browser
test covers the delayed label; a runner test covers rejudging only after
evidence changes. The exploratory Google Maps YAML journey was removed from
the committed suite because its later hotel flow was incomplete.

## 2026-09-24 — Google Flights trip type accessible name

**Problem.** Sedum omitted the visible “Round trip” combobox from click
candidates. Chrome's accessibility tree named the control, but Sedum used its
ordinary page-text extractor for `aria-labelledby`. That extractor correctly
omits text inside controls and `aria-hidden` nodes, so it returned an empty
name for the referenced label and skipped the control.

**Alternatives considered.** A selector for Google Flights would couple Sedum
to that site. Using `innerText` for all labels would still miss some referenced
hidden labels and blur the distinction between an accessible name and page
text. Querying Chrome's accessibility tree for every element would add a
browser-specific round trip for each candidate. We instead added a separate
text path for explicit `aria-labelledby` references; page digests and nearby
context retain their existing visibility and editable-value rules.

**Verification.** A local browser regression reproduces an `aria-hidden`
referenced label in a combobox. The live Google Flights candidate probe passes
after the fix. The full default regression suite passed (529 tests).

## 2026-09-24 — Long accessible names blocking Google Flights

**Problem.** Three of 66 click candidates on the Flights page had names longer
than the 120 code point provider limit. Sedum rejected the entire candidate
batch before calling the resolver, including the short “Round trip” control.

**Alternatives considered.** Raising the provider limit only moves the ceiling
and leaves arbitrarily long labels possible. Dropping long controls would hide
potential targets from the choice set. Truncating at the provider boundary
would leave browser action identity and cache rules unaware of the loss. Page
extraction now emits a visibly shortened 120 point name while keeping the full
label as local metadata for target revalidation. Truncated controls cannot use
the locator cache; duplicate shortened names remain subject to the existing
ambiguity and unique-refresh checks.

**Verification.** A local browser regression covers a long unrelated button,
the bounded candidate projection, a normal target resolution, and rejection
after the full hidden suffix changes. The Flights YAML flow now passes its
first trip-type click, which previously failed with `request_too_large`.
Typecheck and the full default regression suite passed (529 tests).

## 2026-09-24 — Visible menu option becoming stale before click

**Problem.** Google Flights’ “One way” option resolved confidently but Sedum
scrolled it even though it was already in view. The site changed its menu on
that scroll, so the browser correctly rejected the old aim before any click.

**Alternatives considered.** Reusing the old ref after a revision would bypass
the changed page state. Relaxing the revision rule for all mutations would
permit clicks on changed controls. The page script now hit tests a visible
control before scrolling. If a scroll is needed and changes the page, the
old aim remains stale. The flow runner also allows one new resolution and
action attempt only after a proven pre-dispatch stale result; an action that
may have started is never replayed.

**Verification.** DevTools observed the scroll-triggered menu mutations. A
local browser regression checks that an in-view control is not scrolled; a
runner test checks one safe retry and no retry after an uncertain action.

## 2026-09-24 — Dynamic page revisions during locator choice

**Problem.** GitHub and Google Flights change unrelated DOM content while a
model chooses a control. Sedum treated any revision change as a stale target,
even when the named control remained the same DOM node. GitHub's “Go to file”
field stayed present while nearby text changed from “Branches” to “Code”.

**Alternatives considered.** Ignoring all revisions would risk selecting a
new competitor or a replaced control. Waiting longer before every step would
slow stable pages and cannot guarantee a dynamic page stays quiet during a
provider call. Sedum now gives elements document-local identity tokens. After
one Choice round, it performs a complete fresh scan. An unchanged choice
surface can survive unrelated revision changes; when the surface changes, a
selected control must be the same node, uniquely named, semantically stable,
and explicitly named in the sentence. Repeated labels and changed competitors
remain stale. A stale first observation also gets a longer quiet period before
the existing one-time retry.

**Verification.** Local locator tests cover peer drift and unrelated changes,
plus a new same-name competitor and replacement node. The GitHub YAML first
fill and both Flights trip-type clicks now pass. Typecheck and the full default
regression suite passed (533 tests).

## 2026-09-24 — Selection state in assertion evidence

**Problem.** Flights visibly selected “One way”, but Sedum's assertion digest
omitted the text because it was inside a noneditable combobox and an
`aria-hidden` span. The text judge therefore rejected a true claim.

**Alternatives considered.** Including all control text would expose editable
field values. Asking the judge to infer state from surrounding page prose
would leave the actual selection unobserved. The digest now includes bounded
rendered selection text from noneditable comboboxes and native selects while
continuing to exclude editable values and enforce the 4,096 point limit.

**Verification.** A browser regression checks the selected text under
`aria-hidden`, a native select, and privacy of editable values. The Flights
YAML journey then passed its “One way” verification. A separate negative
Return-field claim was removed from the journey because the digest does not
contain a complete form-control inventory and cannot prove that absence.

## 2026-09-24 — Transient empty pages and candidate snapshot collection

**Problem.** Booking returned a quiet, empty transition document, then
changed its home page during candidate pagination. A first-step locator could
fail before the destination control appeared.

**Alternatives considered.** A fixed site delay would slow every run and
would not guarantee readiness. Reusing a target after a revision would risk
acting on a changed node. The runner now makes bounded read-only retries when
there are zero candidates. Candidate pagination keeps its original snapshot
across unrelated DOM revisions, while target selection still requires a fresh
full scan and identity check before action.

**Verification.** The browser integration test covers snapshot continuation
after a revision; typecheck and locator tests pass. Exploratory headed runs
exposed Booking's optional sign-in dialog, so that YAML journey was removed
from the committed suite.

## 2026-09-24 — YAML journey scope

**Problem.** Dense Wikipedia and GitHub pages exceed the 4,096 point digest
ceiling, and editable field values are deliberately excluded from assertion
evidence. Intermediate text-judge checks therefore failed before the useful
actions could run. The Flights origin control also appeared under a different
name than the journey expected.

**Alternatives considered.** Raising the digest cap would only move the bound.
Truncating a page to force a judgment would present incomplete evidence as
complete. The YAML journeys now focus on actions that the locator and browser
can check directly: search submission, file selection, and the explicit
Flights trip-type state check. A future scoped assertion
protocol can add complete evidence for claims on dense pages.

## 2026-09-24 — Stable evidence across unrelated page revisions

**Problem.** The Flights selection was judged from a complete digest, but a
page revision arrived while the provider answered. Sedum rejected the verdict
even when the selected trip type and all digest text were unchanged.

**Alternatives considered.** Ignoring the version would allow a verdict after
the relevant state changed. Calling the provider again could repeat the race
and spend another request. Sedum now reads one new complete digest after a
same-document, same-route revision and accepts the result only when the text
is identical and the new digest is current. Changed evidence still fails
closed.

**Verification.** Assertion-engine tests cover both unchanged and changed
evidence. The headed Flights YAML journey passed all three steps after this
change.

## 2026-09-24 — Real-site journey corrections

**Problem.** Wikipedia's `press Enter` step is unsupported by the current
runner. GitHub's broad `package.json` search produced several plausible file
options.

**Alternatives considered.** Treating an ambiguous GitHub choice as success
would bypass the locator confidence gate. The Wikipedia journey clicks its
visible Search button. GitHub searches for the specific
`packages/web/package.json` path.

**Verification.** Wikipedia, GitHub, and Flights passed in headed YAML runs.
The full regression suite passed 535 tests, and the browser integration suite
passed 45 tests.

## 2026-09-24 — Ranked story phrasing on Hacker News

**Problem.** Sedum correctly collected the first story's rank and title, and
the model favored its comments link. The safety check accepted “first story”
but did not recognize “first ranked story,” so it rejected the same target as
ambiguous. The comments link and age link share a destination, making the
rank-and-purpose evidence necessary.

**Alternatives considered.** Removing the repeated-destination gate would
allow the age link to be chosen by mistake. Hard-coding a Hacker News selector
would couple the locator to one page. Rewording the YAML would avoid this
single failure but leave equivalent natural phrasing unsupported. The generic
rank phrase matcher now accepts an optional “ranked” word while keeping the
existing rank and purpose checks.

**Verification.** A locator regression covers “first ranked story” against
same-destination age and comments links. The headed Hacker News YAML journey
passed after the fix.

## 2026-09-24 — Fallback control names on OpenStreetMap

**Problem.** The visible map search input is named by its `placeholder`, and
the adjacent icon button by its `title`. Sedum omitted both from candidates
because neither had a stronger label or text. The model could only choose
“no match” for the search field.

**Alternatives considered.** Adding selectors for OpenStreetMap's input and
button would be site-specific. Using input values as names would expose typed
data. The generic name extractor now uses a nonempty placeholder for text
inputs and textareas, and `title` when a control has no text or stronger name.
Empty ARIA references and labels fall through to these sources. Input values
remain excluded from text-field names and digests.

**Verification.** A browser regression covers a placeholder-only field, an
icon button with `title`, stronger-name precedence, empty-label fallback,
hidden controls, and input-value privacy. The headed OpenStreetMap YAML
journey passed after the fix.

## 2026-09-24 — Five additional public-site journeys

**Problem.** The original three retained journeys covered a narrow set of controls.
They did not exercise repeated links in a ranked table, a dynamic add/remove
interaction, placeholder-only map search, documentation navigation, or an npm
result card.

**Alternatives considered.** Adding broad assertions to dense and changing
pages would run into the current complete-digest ceiling or volatile content.
The new YAML journeys target stable user actions on five public sites, keeping
their steps within Sedum's supported click and type operations.

**Verification.** All five new journeys passed together in headed Chrome with
zero flagged steps. The committed suite contains eight YAML journeys after
removing the exploratory Booking and Google Maps tests. All eight passed in one
headed run with the locator cache disabled and zero flagged steps. The full
default regression suite passed 536 tests, and the browser integration suite
passed 47 tests.
