# Sedum

Sedum is an open source CLI for browser driven test flows. It runs YAML tests through a real browser and the TypeSafe provider, from one file or a project suite.

## Requirements

- Node.js 20.19 or newer
- Corepack with the pinned pnpm version from `package.json`

## Develop

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test:coverage
corepack pnpm fixtures:verify
node packages/cli/dist/cli.js --version
```

## Run flows

Inspect the available commands and command-specific options with:

```sh
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js run --help
node packages/cli/dist/cli.js browsers install --help
node packages/cli/dist/cli.js doctor --help
```

For project defaults and a no-argument `sedum run`, add a
[`sedum.config.yaml`](docs/configuration.md). Sedum loads secrets only from the
invoking process or the `.env` beside that project config.

Check tests without a browser or key, and list what a suite contains (see
[CLI commands](docs/cli.md)):

```sh
node packages/cli/dist/cli.js validate fixtures/saucedemo-login.test.yaml
node packages/cli/dist/cli.js list fixtures --json
```

Install Chromium with `node packages/cli/dist/cli.js browsers install chromium`,
set `TYPESAFE_API_KEY` and `SAUCE_PASSWORD`, then run the included live fixture:

```sh
node packages/cli/dist/cli.js run fixtures/saucedemo-login.test.yaml
node packages/cli/dist/cli.js run fixtures/saucedemo-wrong-claim.test.yaml
node packages/cli/dist/cli.js run fixtures/saucedemo-checkout.test.yaml
```

Use `--strict` when uncertainty flags must fail the shell gate, and `--costs`
to retain model token/cost lines when stdout is redirected:

```sh
node packages/cli/dist/cli.js run fixtures/saucedemo-login.test.yaml --strict --costs
```

With no path, `run` uses the configured test directory. You can also name a
directory and filter its tests by path, tags, or name. Retries repeat the whole
test from fresh setup, and a deadline keeps the run bounded:

```sh
node packages/cli/dist/cli.js run fixtures --include '**/*login*.test.yaml' --retries 2 --timeout-minutes 5
```

Use `--url-override` to run the same flows against another site's origin while
keeping each flow's path, query, and fragment. Use `--headed` to watch the
browser, or `--reporter json --reporter-dir reports` for a separate JSON copy.
See [CLI commands](docs/cli.md) for all run options and
[run results](docs/run-result.md) for attempt history and output files.

The first command should exit `0`; the deliberately false claim exits `1`.
A flagged pass exits `0` normally and `2` with `--strict`. An unavailable
browser, provider, flow, runtime value, invalid command, zero-test run, or
timeout exits `3`. SIGINT/SIGTERM use conventional process exits `130`/`143`
after the partial result is finalized.

In a terminal, Sedum shows coloured per-test result labels and transient live
progress. When stdout is redirected, output is stable, ANSI-free, and
untruncated. Both forms include ordered per-test results, verdict/flag counts,
and canonical artifact paths. Token and cost lines are omitted from redirected
output unless `--costs` is passed.

`packages/core` owns engine contracts and the browser script boundary. `packages/provider-typesafe` will own model SDK effects. `packages/reporters` will consume the core result contract. `packages/cli` handles process arguments and composition. The browser bundle is emitted at `packages/core/dist/page-script/index.global.js`.

PR CI builds, lints, typechecks, and runs unit tests on Node 20, 22, and 24 on Linux and macOS, plus Node 24 on Windows. Node 24 jobs on all three operating systems install Chromium and run the browser engine suite against the local fixture site with recorded TypeSafe replies, without an API key. A separate manual workflow runs live API checks. For the alpha, Linux and macOS are verified; Windows remains experimental until its CI has been green consistently.

The [CLI project in Linear](https://linear.app/sedum/project/cli-dabe6965b916) tracks the work. [SED-15](https://linear.app/sedum/issue/SED-15/repo-scaffold-pnpm-turbo-monorepo) covers this scaffold; [SED-16](https://linear.app/sedum/issue/SED-16) covers the PR CI matrix. Decisions in private Linear issues are not copied into this public repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for change guidelines and [SECURITY.md](SECURITY.md) for vulnerability reports.
