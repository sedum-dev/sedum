# Fixtures

Local browser pages and flow fixtures for engine tests live here. Keep
credentials and personal data out of fixtures. The Sauce Demo flows use
`$SAUCE_PASSWORD` at runtime and are invoked explicitly; they are not a
discovered test suite.

## Local fixture site

`site/server.ts` starts a private HTTP server on an ephemeral `127.0.0.1` port.
It has a synthetic login (`fixture_user` / `fixture_password`), repeated product
buttons, cart and checkout, duplicate same-text links, a delayed page, and a
rerendering list. Each browser test uses a fresh context. No external assets or
Sauce Demo content are copied into the site.

## Recorded TypeSafe replies

`replies/v1.json` contains the versioned request and reply data used by the
fixture engine tests. The test-only transport replays through the real TypeSafe
adapter and never contacts the provider in replay mode. Candidate IDs are
randomized by the page script, so only those run-local IDs are mapped to stable
positional aliases in the recording. Prompt text, candidate descriptions,
model, page digest, and answer probabilities are preserved. A missing request
fails with its SHA-256 key; changed prompts require a new recording.

After building and installing Chromium with `node packages/cli/dist/cli.js
browsers install chromium`, run `pnpm fixtures:verify`. It removes
`TYPESAFE_API_KEY` from the test process. Normal `sedum run` against a user site
still needs a provider key.

To replace recordings intentionally, set both `SEDUM_RECORD_REPLIES=1` and
`TYPESAFE_API_KEY`, then run `pnpm fixtures:record`. This calls the live API and
may incur charges. The recorder writes to a private staging file, runs keyless
replay verification against it, and replaces `replies/v1.json` only if both runs
pass. Review the diff in `replies/v1.json`, then run `pnpm fixtures:verify`
without a key. The fixture tests cover delayed evidence, an observation timeout,
a stale target after rerender, and one executed click. SED-65 owns broader retry
policy tests.
The dedicated GitHub Actions live-provider workflow is manual and uses a
repository secret. It never runs on pull requests.
