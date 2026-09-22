# Contributing

Thanks for helping build Sedum. Open an issue before a large change so the public behavior and package boundary can be agreed first.

Use Node 20.19 or newer and the pinned pnpm version. Run `corepack enable` once, then `corepack pnpm install --frozen-lockfile`, `corepack pnpm build`, `corepack pnpm test`, `corepack pnpm typecheck`, and `corepack pnpm lint` before proposing a change. Run `corepack pnpm format:check` for formatting. Add focused tests for new behavior, including failures. Keep browser and provider tests local and credential free in ordinary CI.

Prefer pure functions for deterministic decisions and explicit injection at effect boundaries. Keep imports between packages through declared package exports. Add a Changeset when changing a published package's behavior or public API. The initial packages are private until release decisions are settled.

For browser-backed engine changes, install Chromium with `node packages/cli/dist/cli.js browsers install chromium` after building and run `corepack pnpm fixtures:verify`. The local fixture site and recorded provider replies are documented in [fixtures/README.md](fixtures/README.md). Ordinary tests and CI need no TypeSafe API key.
