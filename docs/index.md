---
title: "Sedum documentation"
---

These pages describe how to write, configure, and run Sedum tests.

- [Plain-English browser tests](/plain-english-tests): the basics of e2e tests written in plain English, and where Sedum fits.
- [Probabilistic testing](/probabilistic-testing): how scores become verdicts, flags, and exit codes, and how to tune thresholds.
- [TypeScript tests](/typescript-tests): `*.test.ts` files with `test()`, `ai` steps, values and secrets, groups, `extract`, and Playwright code between steps.
- [YAML format](/format): the `*.test.yaml` and `*.module.yaml` format, data, placeholders, modules, and hooks.
- [Project configuration](/configuration): `sedum.config.yaml`, named environments, `.env` loading, test discovery, and precedence.
- [CLI commands](/cli): `sedum init`, `doctor`, `run`, `validate`, `list`, and `browsers install`, with options, output, and exit codes.
- [Running in CI](/ci): JUnit output, job summaries, and GitHub Actions, GitLab, and Jenkins examples.
- [Run results](/run-result): the `RunResult` schema, live progress, reporters, and evidence privacy.
- [Assertion engine](/assertion-engine): `verify` and `measure` results, verdict policy, observation errors, and page limits.
- [Step classification](/classification): supported operations, offline validation, and the classification cache.
- [Local locator cache](/locator-cache): development and CI defaults, parallel runs, privacy, and clearing the cache.
- [TypeSafe provider](/provider-typesafe): provider setup, data sent to the provider, and the opt-in live check.
- [Clef provider](/provider-clef): Cloudflare credentials, models, privacy, pricing, and the text-only Phase 1 scope.
