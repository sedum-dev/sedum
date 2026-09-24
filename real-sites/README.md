# Real website Sedum tests

These YAML tests run through Sedum's CLI against live websites. They are
opt-in because they use the TypeSafe provider, network access, and public pages
whose content can change. Set `TYPESAFE_API_KEY` in the environment or in a
local `real-sites/.env` file.

From this directory, run one test or the suite:

```sh
node ../packages/cli/dist/cli.js validate tests
node ../packages/cli/dist/cli.js run tests/wikipedia-search.test.yaml --headed
node ../packages/cli/dist/cli.js run tests --headed
```

Google Flights checks the selected trip type, GitHub opens a specific
repository file, and Wikipedia submits a search. Prices and counts are absent
from required claims.

The additional journeys cover the first Hacker News discussion, a repeatable
add/remove interaction on The Internet, an OpenStreetMap place search, Python
documentation navigation, and opening the exact npm package from search
results. They use live public pages, so page changes can alter the outcome.

The keyless browser probes in `packages/core/src/real-sites.live.test.ts` are
separate diagnostics for candidate extraction and action execution. They do
not replace these YAML journeys.
