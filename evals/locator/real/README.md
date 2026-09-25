# Real-site locator eval

The same measurement as the synthetic eval, on frozen copies of real public
websites. Synthetic pages are good for comparing strategies; real pages show
how often each failure happens on the sites people actually test.

```sh
corepack pnpm build
node evals/locator/real/capture.mjs --all          # freeze every site in sites.json
node evals/locator/real/inspect.mjs <site-id>...   # list controls for labeling
corepack pnpm eval:locator --suite real            # run the cases
corepack pnpm eval:locator --suite real --site hacker-news -v
```

## What is committed, and what is not

Committed here: `sites.json`, the capture and inspection tools, and
`cases/<site>.json` (sentences, and selectors for the expected elements).
None of these contain page content.

Not committed: the snapshots, screenshots, inventories, and recorded model
replies. They copy third-party page content, so they live in the store,
`evals/locator/real/store/` (ignored by Git), or wherever `SEDUM_EVAL_STORE`
points. Keep the store in a private location. Without a snapshot, a site's
cases are skipped with a message.

## Capture

`capture.mjs` loads each live page at 1280×900 in Chromium, scrolls through
it so lazy content renders, returns to the top, and freezes the DOM:

- scripts, preloads, and other network-bound tags are removed;
- stylesheets are inlined from the CSSOM, so CSS-in-JS and constructed
  stylesheets survive; shared constructed sheets are stored once and
  re-adopted by the snapshot's only script, which makes no requests;
- open shadow roots are kept as declarative shadow DOM;
- checkbox, radio, and option state is written to attributes;
- images and media keep their rendered size but load nothing; external
  `url()` references in CSS are removed.

Each capture writes `snapshot.html.gz`, `live.png` and `frozen.png` (compare
them to judge fidelity), and `meta.json` with the URL, status, time, size,
and hash. Cross-origin iframes and closed shadow roots cannot be captured;
modal dialogs lose their top-layer state.

Behind a TLS-intercepting proxy, set `SEDUM_CAPTURE_CA` to the proxy's CA
certificate so Chromium trusts that one key.

## Labeling

`inspect.mjs` opens a snapshot offline and writes `inventory.txt`,
`inventory.json`, and `inspect-<n>.png` for the first screens. The inventory
lists every visible control a person could click or type into, including
elements in shadow roots, clickable `div`s, and ARIA widgets, each with a
unique selector chain. The `sedum` column says whether Sedum's extractor
currently offers it (`click` or `fill`); in the screenshots, blue boxes are
offered and red boxes are not.

A case file names the site, maps gold ids to selector chains, and lists
cases in the same format as the synthetic suites:

```json
{
  "site": "wikipedia-article",
  "targets": { "search": "#searchInput" },
  "cases": [
    {
      "id": "wp-search",
      "op": "fill",
      "sentence": "type {{query}} in the Search Wikipedia field",
      "gold": ["search"],
      "tags": ["exact-label"]
    }
  ]
}
```

`>>>` steps into an open shadow root: `reddit-search-large >>> #search-input >>> textarea`.
At run time every target must match exactly one element, or its cases are
skipped and reported. Label targets that a person would use even when Sedum
cannot see them today; those cases measure recall.

Recorded model replies for real sites are written to `<store>/replies/`.
