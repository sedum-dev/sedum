# Sedum

Sedum is an open source CLI for browser driven test flows. This repository is the initial TypeScript scaffold. The engine, browser interaction, and model adapters are being built in the M1 milestone; the only working CLI commands today are `--version` and `--help`.

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
node packages/cli/dist/cli.js --version
```

`packages/core` owns engine contracts and the browser script boundary. `packages/provider-typesafe` will own model SDK effects. `packages/reporters` will consume the core result contract. `packages/cli` handles process arguments and composition. The browser bundle is emitted at `packages/core/dist/page-script/index.global.js`.

The [CLI project in Linear](https://linear.app/sedum/project/cli-dabe6965b916) tracks the work. [SED-15](https://linear.app/sedum/issue/SED-15/repo-scaffold-pnpm-turbo-monorepo) covers this scaffold; [SED-16](https://linear.app/sedum/issue/SED-16) covers the PR CI matrix. Decisions in private Linear issues are not copied into this public repository.

See [CONTRIBUTING.md](CONTRIBUTING.md) for change guidelines and [SECURITY.md](SECURITY.md) for vulnerability reports.
