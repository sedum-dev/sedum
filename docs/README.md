# Docs

See [TypeSafe provider](provider-typesafe.md) for provider configuration, data sent, and the opt-in live check. See [step classification](classification.md) for operations, offline validation, and the classification cache.

See [assertion engine](assertion-engine.md) for `verify` / `measure` results, verdict policy, observation errors, and current page limits.

Public design and usage documentation will live here as engine behavior lands. The current package boundaries are described in the root README.

## CLI output and exits

`sedum --help` lists only implemented commands; every command has its own
`--help`. `sedum run <file.test.yaml>` prints one ordered result line per test
and aggregate verdict counts plus separate `low_confidence` and `contradiction`
counts. Terminals receive coloured result labels and
transient progress. Redirected output contains no ANSI or cursor controls and
does not truncate paths or diagnostics.

Run exits are `0` for a pass (including a flagged pass by default), `1` for a
failed test, `2` for a flagged pass under `--strict`, and `3` when the command
or run could not produce a trustworthy verdict. `--strict` never changes the
canonical verdict or flags. Model tokens and costs are shown automatically in
a terminal; pass `--costs` to include them in redirected output.

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
