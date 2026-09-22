# Docs

See [TypeSafe provider](provider-typesafe.md) for provider configuration, data sent, and the opt-in live check. See [step classification](classification.md) for operations, offline validation, and the classification cache.

See [assertion engine](assertion-engine.md) for `verify` / `measure` results, verdict policy, observation errors, and current page limits.

Public design and usage documentation will live here as engine behavior lands. The current package boundaries are described in the root README.

## Browser setup

Sedum uses `playwright-core` and does not download a browser during a test run. Install the matching managed Chromium binary explicitly:

```sh
sedum browsers install chromium
```

On supported Linux environments, install system dependencies as well:

```sh
sedum browsers install chromium --with-deps
```

Sedum prefers an installed Google Chrome channel when available. If Chrome is not available, it uses the matching Playwright-managed Chromium binary. An arbitrary Chromium executable on `PATH` is not used as a fallback.
