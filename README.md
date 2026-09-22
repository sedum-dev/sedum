# Sedum

Sedum is an open source CLI for browser driven test flows. This repository is the initial TypeScript scaffold. The M1 walking skeleton runs one hand-written YAML test through a real browser and the TypeSafe provider.

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

## Walking skeleton

Install Chromium with `node packages/cli/dist/cli.js browsers install chromium`,
set `TYPESAFE_API_KEY` and `SAUCE_PASSWORD`, then run the included live fixture:

```sh
node packages/cli/dist/cli.js run fixtures/saucedemo-login.test.yaml
node packages/cli/dist/cli.js run fixtures/saucedemo-wrong-claim.test.yaml
node packages/cli/dist/cli.js run fixtures/saucedemo-checkout.test.yaml
```

For temporary visual debugging only, prefix either command with
`SEDUM_HEADED=1`. This escape hatch will be removed once the final CLI launch
configuration lands.

The first command should exit `0`; the deliberately false claim exits `1`.
An unavailable browser, provider, flow, or runtime value exits `3`. This is a
single-file M1 slice: hooks, modules, retries, final reporters, and the broader
CLI grammar are not implemented here.

`packages/core` owns engine contracts and the browser script boundary. `packages/provider-typesafe` will own model SDK effects. `packages/reporters` will consume the core result contract. `packages/cli` handles process arguments and composition. The browser bundle is emitted at `packages/core/dist/page-script/index.global.js`.

PR CI builds, lints, typechecks, and runs unit tests on Node 20, 22, and 24 on Linux and macOS, plus Node 24 on Windows. Node 24 jobs on all three operating systems install Chromium and run the browser engine suite against the local fixture site with recorded TypeSafe replies, without an API key. A separate manual workflow runs live API checks. For the alpha, Linux and macOS are verified; Windows remains experimental until its CI has been green consistently.

The [CLI project in Linear](https://linear.app/sedum/project/cli-dabe6965b916) tracks the work. [SED-15](https://linear.app/sedum/issue/SED-15/repo-scaffold-pnpm-turbo-monorepo) covers this scaffold; [SED-16](https://linear.app/sedum/issue/SED-16) covers the PR CI matrix. Decisions in private Linear issues are not copied into this public repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for change guidelines and [SECURITY.md](SECURITY.md) for vulnerability reports.
