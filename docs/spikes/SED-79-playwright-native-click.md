# SED-79 spike: Playwright-native clicks and accessibility snapshots

This is an exploratory branch stacked on SED-21, not an approved implementation or a review sign-off. Tracking: [SED-79](https://linear.app/sedum/issue/SED-79/fix-canceled-link-navigation-in-browser-click-execution) · parent [SED-21 draft PR #2](https://github.com/sedum-dev/sedum/pull/2).

Run the built-browser experiments with:

```sh
SEDUM_BROWSER_INTEGRATION=1 corepack pnpm exec vitest run packages/core/src/playwright-native.spike.integration.test.ts
```

The tests use `playwright-core` 1.63.0, the version already pinned by `@sedum-dev/core`. Some passing tests deliberately assert _unsafe_ native behavior so the limitations remain reproducible.

## What the experiment establishes

| Question                                                                                                                 | Chromium fixture result                                                                                                                                                     | Implication                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Does a native `locator.click()` honor page cancellation, including a previously cached `Event.prototype.preventDefault`? | Yes; the handler runs and the page stays put.                                                                                                                               | Sedum's early cancel/manual replay is unnecessary for this case and causes CR-11.                           |
| Does an ordinary native link click navigate and preserve its referrer?                                                   | Yes.                                                                                                                                                                        | Do not manually call `location.assign` to emulate browser navigation.                                       |
| Can a bare native click prevent a page capture handler from changing a link's `href`?                                    | No; it follows the changed URL.                                                                                                                                             | Replacing `clickRef` with only `getByRole(...).click()` would regress wrong-destination safety.             |
| Can Playwright routing prevent that unexpected document request?                                                         | `route.abort` blocks the request but Chromium navigates to an error page. Returning HTTP 204 for the unexpected document request retains the original page in this fixture. | A network guard is worth prototyping, but 204 is not yet a proven cross-browser or general solution.        |
| Can locators preserve an intended item among repeated buttons?                                                           | A locator scoped by an item label fails when that item is removed, without clicking its sibling.                                                                            | Semantic scoping is promising; positional `nth()` must not replace full-set uniqueness and live validation. |
| Does Playwright re-check an accessible name after hover mutates the same node?                                           | No; a bare locator still clicks the now-renamed button.                                                                                                                     | Sedum still needs an action-boundary check and a non-retryable outcome once page handlers may have run.     |
| Can `page.ariaSnapshotJSON({mode: 'ai'})` provide candidate roles, names, hierarchy, and refs?                           | Yes. The raw tree also contains link URLs and editable input values.                                                                                                        | Snapshot-derived candidates need an explicit SED-12 allowlist before provider use. Never send the raw tree. |

## Recommendation for the SED-79 plan

1. Keep Playwright's native click/default behavior; remove Sedum's link default hold-and-replay logic only after a safe destination guard is demonstrated. Preserve the existing SED-21 live aim, stale-target checks, and non-retryable action-started result.
2. Prototype the destination guard with local browser fixtures for changed `href`, page cancellation, ordinary links, redirects, same-document route changes, and page-initiated navigation. The HTTP 204 result above is only one Chromium fixture. Interception can miss Service Worker-handled requests unless workers are blocked, which itself changes site behavior; document the supported scope before relying on it.
3. Evaluate `ariaSnapshotJSON` as an observation source, not a provider payload or cache contract. Its documented free-form nodes include role/name/text, state flags, `url`, and optional AI refs. Sedum still needs bounded extraction, modal ambiguity policy, full candidate-set checks, provider allowlisting, and SED-14 cache signals such as hooks/IDs/tags that the snapshot does not directly supply.
4. Do not merge this spike as the SED-79 repair. The expected-failure regression in SED-21 must become an ordinary passing test, and an independent review must check that no wrong navigation or wrong-target click was introduced.

Sources: [Playwright locator clicks](https://playwright.dev/docs/api/class-locator#locator-click), [actionability](https://playwright.dev/docs/actionability), [structured ARIA snapshots](https://playwright.dev/docs/api/class-page#page-aria-snapshot-json), [network routing and Service Workers](https://playwright.dev/docs/network), and [Playwright MCP snapshot refs](https://playwright.dev/mcp/snapshots). Playwright MCP resolves its snapshot refs, but the public `playwright-core` Page/Locator API does not document an equivalent ref-to-locator operation; that remains a bridge question, not an assumed capability.
