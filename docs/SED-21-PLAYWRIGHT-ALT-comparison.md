# SED-21 Playwright alternative: implementation comparison

This experiment lives in `experiment/sed-21-playwright-snapshots-alt`. The
original SED-21 branch and PR #2 are unchanged. The owner approved continuing
after the feasibility gate showed a same-node hover relabel during native
click. This report does not propose a merge or change SED-21's current
bundle/injection acceptance text.

## Behavior and boundaries

| Area              | Original SED-21 bridge                                                 | Playwright alternative                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observation       | Injected TypeScript IIFE collects candidates, digest, and hit evidence | Structured ARIA JSON snapshot for candidates, plus bounded stateless DOM reads for visible text, flattened-card context, element attributes, and hit receiver                                               |
| Target            | Bridge identity and `ElementHandle` click                              | Unique semantic locator maps to an exact leased `ElementHandle`; route, document, snapshot, ancestor attributes, and receiver are checked before native click                                               |
| Resolver/Judge    | Explicit provider projection in protocol                               | `resolverPage()` permits only `id,tag,role,name,peers,editable,disabled`; `judgeText()` permits only bounded visible non-editable text; raw snapshot, route, href, selector, and editable values stay local |
| Cache             | Page cache HMAC contract and matcher                                   | Full-route HMAC key, keyed transient signals, version and conflict checks, full bounded candidate scan, unique semantic identity, and staging only after successful action; store integration is later work |
| Click             | Native handle click after bridge checks                                | Native handle click after snapshot/DOM checks; uncertain click failure is non-retryable `action_started`                                                                                                    |
| Page installation | Built IIFE and bridge                                                  | No IIFE, `window.__sedum`, event patch, or observer; narrow `evaluate` calls remain                                                                                                                         |

The alternative browser fixtures pass for repeated product controls, a plain
title and flattened `div` cards, ambiguity rejection, 130-candidate paging,
modal scope, editable/hidden text exclusion, rerendered clone, route-only SPA
change, attribute-only and semantic changes, disabled-to-enabled relabeling,
occlusion, pointer-events,
delayed render, scroll relabel, lease cleanup, native cancellation, navigation,
referrer policy, and capture-phase href mutation. Unit tests cover snapshot
projection and cache matching. The alternative has 20 browser observation
tests; the original page-script suite has 34 browser tests. Counts describe
coverage size, not parity: the two suites exercise different contracts.

The hover fixture still demonstrates a wrong-target click after a same-node
`pointerenter` relabel, as explicitly allowed by the owner's amendment. A
capture handler can also change a link's `href` after the final check; native
navigation then follows the changed destination. These are browser event-order
risks, not proven application outcomes. A resolved click means input completed.
The alternative does not prove zero wrong-target dispatch during Playwright's
native-click interval. If that becomes a hard requirement, the dispatch design
must change.

## Limits and semantic coverage

The snapshot parser and projection reject malformed or over-budget input as
incomplete. Snapshots are limited after transfer to 1 MiB, 20,000 nodes, and
2,048 candidates. There is no pre-transfer snapshot byte cap from Playwright;
SED-80 must assess that resource exposure. The visible text probe is limited
to 4,096 Unicode code points and 20,000 text nodes. Resolver pages contain at
most 128 candidates; cache matching considers the full bounded set. Incomplete
observations cannot become a clean miss, provider request, or cache hit through
the projection and matcher APIs.

The ARIA snapshot does not always preserve product-card boundaries. A bounded
DOM context probe handles the tested flat `div` layout, but unfamiliar layouts
may yield `mapping_ambiguous`. The visible text probe reads rendered DOM text;
it does not establish parity for CSS generated text, shadow DOM, canvas, or
other nonstandard surfaces. Text that is visible but outside the 4,096 point
cap fails closed. The alternative therefore reduces in-page code but does not
remove custom DOM inspection or prove full semantic coverage against PR #2.

## Footprint and local timing

Measured on this worktree with Node 20, Chromium 153, ten repeated `article`
cards, six observations per mode, one local process run each:

| Metric                           |            Original bridge |     Playwright alternative |
| -------------------------------- | -------------------------: | -------------------------: |
| Core built JS                    |               23,780 bytes |               40,142 bytes |
| Separate IIFE                    |               22,066 bytes |                    0 bytes |
| Combined built JS                |               45,846 bytes |               40,142 bytes |
| Main implementation files, lines |                      1,858 |                      1,676 |
| Cold observation                 |                     120 ms |                     202 ms |
| Warm observations                | 111, 109, 116, 114, 114 ms | 171, 174, 157, 156, 157 ms |

The timing fixture uses each branch's own quiet, candidate, and digest path.
It is a small local comparison, not a performance benchmark across sites or
machines. The alternative has fewer implementation lines and no page asset,
but a larger core entry file and slower observations on this fixture. Both
branches use the same native handle click interval that exposed the hover
relabel; the extra bridge does not remove that event-order race.

## Verification

In the alternative worktree, `corepack pnpm build`, `corepack pnpm typecheck`,
`corepack pnpm lint`, `corepack pnpm format:check`, and
`SEDUM_BROWSER_INTEGRATION=1 corepack pnpm test:coverage` exited 0. Coverage
ran 44 tests across six files, with 85.77% overall statement coverage and
63.01% for the new observer. The lower observer percentage reflects untested
error and browser edge branches; the listed target and provider-boundary
fixtures passed. The synthetic hover reproduction separately exited 0 while
asserting that the known wrong-target dispatch occurs.

Disposition: this is a reviewable alternative, with smaller combined JS and
source footprint at the cost of slower local observations and unresolved
semantic and resource limits. An owner decision is still needed to replace
PR #2 or amend SED-21's literal built-script acceptance criterion.
