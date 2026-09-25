# Contributing

Thanks for helping build Sedum. Open an issue before a large change so the public behavior and package boundary can be agreed first.

Use Node 20.19 or newer and the pinned pnpm version. Run `corepack enable` once, then `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, `corepack pnpm test`, `corepack pnpm typecheck`, and `corepack pnpm lint` before proposing a change. Run `corepack pnpm format:check` for formatting. Add focused tests for new behavior, including failures. Keep browser and provider tests local and credential free in ordinary CI.

Prefer pure functions for deterministic decisions and explicit injection at effect boundaries. Keep imports between packages through declared package exports. Add a Changeset when changing a published package's behavior or public API. The initial packages are private until release decisions are settled.

For browser-backed engine changes, install Chromium with `node packages/cli/dist/cli.js browsers install chromium` after building and run `corepack pnpm fixtures:verify`. The local fixture site and recorded provider replies are documented in [fixtures/README.md](fixtures/README.md). Ordinary tests and CI need no TypeSafe API key.

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

Run the Sauce Demo fixtures against the live site with `SAUCE_PASSWORD` and `TYPESAFE_API_KEY` set. To use a compatible provider, also set `TYPESAFE_BASE_URL` and, if needed, `TYPESAFE_DEFAULT_MODEL`. The first should exit `0`; the deliberately false claim exits `1`:

```sh
node packages/cli/dist/cli.js run fixtures/saucedemo-login.test.yaml
node packages/cli/dist/cli.js run fixtures/saucedemo-wrong-claim.test.yaml
node packages/cli/dist/cli.js run fixtures/saucedemo-checkout.test.yaml
```

Add `--headed` to watch the browser while debugging.

## Packages

`packages/core` owns engine contracts and the browser script boundary. `packages/provider-typesafe` owns model SDK effects. `packages/reporters` consumes the core result contract. `packages/cli` handles process arguments and composition. The browser bundle is emitted at `packages/core/dist/page-script/index.global.js`.

## CI

PR CI builds, lints, typechecks, and runs unit tests on Node 20, 22, and 24 on Linux and macOS, plus Node 24 on Windows. Node 24 jobs on all three operating systems install Chromium and run the browser engine suite against the local fixture site with recorded TypeSafe replies, without an API key. A separate manual workflow runs live API checks. For the alpha, Linux and macOS are verified; Windows remains experimental until its CI has been green consistently.

## Planning

The [OSS Library project in Linear](https://linear.app/sedum/project/oss-library-dabe6965b916) tracks the work. Decisions in private Linear issues are not copied into this public repository.
