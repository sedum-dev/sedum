# Docs

These pages describe how to write, configure, and run Sedum tests.

- [Plain-English browser tests](plain-english-tests.md): the basics of e2e tests written in plain English, and where Sedum fits.
- [Probabilistic testing](probabilistic-testing.md): how scores become verdicts, flags, and exit codes, and how to tune thresholds.
- [Test file format](format.md): the `*.test.yaml` and `*.module.yaml` format, data, placeholders, modules, and hooks.
- [Project configuration](configuration.md): `sedum.config.yaml`, named environments, `.env` loading, test discovery, and precedence.
- [CLI commands](cli.md): `sedum init`, `doctor`, `run`, `validate`, `list`, and `browsers install`, with options, output, and exit codes.
- [Running in CI](ci.md): JUnit output, job summaries, and GitHub Actions, GitLab, and Jenkins examples.
- [Run results](run-result.md): the `RunResult` schema, live progress, reporters, and evidence privacy.
- [Assertion engine](assertion-engine.md): `verify` and `measure` results, verdict policy, observation errors, and page limits.
- [Step classification](classification.md): supported operations, offline validation, and the classification cache.
- [Local locator cache](locator-cache.md): development and CI defaults, parallel runs, privacy, and clearing the cache.
- [TypeSafe provider](provider-typesafe.md): provider setup, data sent to the provider, and the opt-in live check.
