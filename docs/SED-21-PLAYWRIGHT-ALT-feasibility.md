# SED-21 Playwright alternative: feasibility gate

**Result: no-go under the approved plan.** The pinned Playwright 1.63.0 native
`ElementHandle.click()` dispatched a click after a hover handler changed the
same target's accessible meaning. This violates the required zero wrong-target
dispatches. The plan says to stop broad implementation and request an owner
choice at this gate.

**Owner decision, 2026-09-21:** Continue the Playwright alternative and relax
the zero wrong-target dispatch requirement for this native-click interval. Keep
exact-target checks before click and a non-retryable result once dispatch may
have started. The original gate result remains recorded as evidence; the
experiment now proceeds under this narrower requirement.

## Reproduction

From the alternative worktree, after `corepack pnpm install --frozen-lockfile`:

```sh
node packages/core/playwright-alt-feasibility.mjs
```

The command exited 0 on Chromium 153.0.8010.12. Its assertions require the
wrong-target dispatch to occur, so a future implementation that prevents it
will cause the fixture to fail and invite re-evaluation. Relevant output:

```text
AMBER_SCOPED_MATCHES 1
BEFORE_HOVER_CLICK Buy amber mug
AFTER_HOVER_CLICK [ 'Buy blue mug' ]
NO_GO native click dispatched after the pinned target changed meaning
```

The fixture captures a fresh ARIA snapshot, confirms the selected exact handle
still has the original name, and confirms the handle is the hit-test receiver.
It then calls `ElementHandle.click()`. The page's `pointerenter` handler changes
that same element's `aria-label` before the click event. The click listener
records the changed meaning. A unique locator and exact handle preserve node
identity, but neither prevents a same-node semantic change during Playwright's
pointer movement. A pre-click stateless probe cannot observe a mutation that
occurs after it returns and before native dispatch.

## Snapshot observations

`page.ariaSnapshotJSON({ mode: "default" })` returned a JavaScript array of
objects. The product grid contained nested `region` and `article` nodes with
headings, price paragraphs, and repeated `Add to cart` buttons. An article
filtered by its heading mapped its button to one live locator. The same
snapshot included rendered paragraph text and the open dialog, omitted hidden
text, and included the textbox's **editable value** in `text` and a link's URL
in `url`. Any provider projection would therefore need an explicit allowlist;
the raw snapshot cannot cross the SED-12 boundary. This gate did not establish
complete Judge digest coverage, cache safety, or packaging parity.

At the gate, no adapter or observation implementation had been started and no
provider request had been made. The owner then relaxed the click-interval
criterion, allowing the alternative implementation to proceed. The original
SED-21 branch and PR remain untouched. The completed implementation and
comparison are recorded in `SED-21-PLAYWRIGHT-ALT-comparison.md`.
