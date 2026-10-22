---
title: "Project configuration"
---

Sedum looks for the nearest `sedum.config.yaml` in the current directory or
one of its parents. The folder containing that file is the project root. If no
file exists, the current directory is the root and the defaults below apply.
Paths and test globs are always relative to that root.

```yaml
tests:
  directory: tests
  include: ["**/*.test.ts", "**/*.test.yaml"]
  exclude: []

affected:
  ignore: []

browser: chrome
viewport: { width: 1280, height: 900 }
thresholds:
  verify: 0.75
  lowConfidenceBand: 0.15
  contradiction: 0.5

# Optional. TypeSafe with jev-latest remains the default.
# provider: { name: clef, model: clef }

# Send screenshots to TypeSafe (default: on for the direct TypeSafe API).
screenshots: true

vision:
  enabled: false

# How long a step waits for the page, in milliseconds (0 to 120000).
stepTimeoutMs: 5000

outputDir: .sedum/runs
reporterDir: .sedum/reports
baseUrl: http://127.0.0.1:3000

environment: local
variables:
  PUBLIC_NAME: example
environments:
  local:
    baseUrl: http://127.0.0.1:3000
    variables:
      ACCOUNT: local-user
  ci:
    stepTimeoutMs: 30000
```

Every key is optional. With no positional file, `sedum run` discovers regular
`*.test.ts` and `*.test.yaml` files under `tests.directory`, applies the
include/exclude globs, and runs the sorted result. Each `test()` in a
`*.test.ts` file is one test. Symlinked directories are not followed. An
explicit `sedum run path/to/file.test.ts` remains supported.

Settings resolve from defaults, then the top-level config, then the selected
named environment, then explicit command overrides. Named environments may
override `baseUrl`, `variables`, `provider.apiKeyEnv`, and `stepTimeoutMs`. Nested settings
merge by field, so an override of viewport width retains the configured height.
For `sedum run`, `--env` selects the named environment before `--browser` and
`--output-dir` override their configured values. `--url-override` then replaces
the origin of the resolved entry URL, preserving its path, query, and fragment.
Run-only `--include`, `--exclude`, `--labels`, and `--name` filters narrow the
discovered candidate files after config selection; explicit file and directory
arguments supply their own candidate set instead of applying the configured
test globs.

Sedum reads at most one dotenv file: `<project-root>/.env`. It never searches a
test directory, child, parent project, or sibling project for secrets. Values
from the invoking process override `.env`; both override config variables with
the same name. Provider credentials are accepted only from the process or this
`.env`, never from `sedum.config.yaml`. `.env` is ignored by Git and should not
be committed.

### Custom credential variable names

Use `provider.apiKeyEnv` to name the environment variable holding the selected
provider's key or token. The vision fallback uses the same provider and key:

```yaml
provider:
  apiKeyEnv: TYPESAFE_LOCAL_E2E_API_KEY
environments:
  staging:
    provider:
      apiKeyEnv: TYPESAFE_STAGING_API_KEY
```

`sedum run --env staging` and `sedum doctor --env staging` use the named
environment's values; environments without overrides inherit the top-level
names. `sedum explore` has no `--env` and uses the name `sedum run` uses without one. Set only variable **names** in YAML, never key values. Names must match
`[A-Za-z_][A-Za-z0-9_]*`. The process value wins over the project-root `.env`
value; blank values are treated as missing. An explicit name disables fallback
to the default names and aliases. Custom credential variables are not exposed
to tests and cannot be stored in config `variables`.

Sedum uses Node's native `.env` parser. Parsing edge cases can vary by Node
version: Node 20, 22, and 24 do not retain `__proto__` from `.env`, though an
explicit process environment value works. Prefer conventional uppercase names
such as `TYPESAFE_LOCAL_E2E_API_KEY` for portability.

Without these settings, existing behavior is unchanged: TypeSafe reads
`TYPESAFE_API_KEY`; OpenRouter reads `OPENROUTER_API_KEY`
or `OPEN_ROUTER_API_KEY`; Clef reads `CLOUDFLARE_AUTH_TOKEN` or
`CLOUDFLARE_API_TOKEN`. For Clef, `provider.apiKeyEnv` renames the token source;
`CLOUDFLARE_ACCOUNT_ID` is still required. Doctor, run diagnostics, and newly
generated init templates use the configured names. Existing init files are kept.

By default, Sedum sends `jev-latest` requests to TypeSafe. A gateway or other
TypeSafe System One-compatible service can be selected with these connection
variables:

```dotenv
TYPESAFE_BASE_URL=https://example.com
TYPESAFE_DEFAULT_MODEL=jev-compatible-model
TYPESAFE_API_KEY=...
```

The base URL must use HTTPS and must not contain credentials, a query, or a
fragment. Sedum's TypeSafe SDK appends `/v1/systemone`; the service must accept
that request and return the TypeSafe System One response shape. The URL defaults
to TypeSafe and the model to `jev-latest`; the API key is read from
`TYPESAFE_API_KEY`.
Process values override the project `.env`. `TYPESAFE_API_KEY` is rejected
from `sedum.config.yaml`.

For **Vercel AI Gateway**, keep `provider.name: typesafe` and use:

```dotenv
TYPESAFE_BASE_URL=https://ai-gateway.vercel.sh/typesafe
TYPESAFE_DEFAULT_MODEL=typesafe-ai/jev
TYPESAFE_API_KEY=your_vercel_ai_gateway_key
```

An explicit `provider.model` overrides the environment model. Use the gateway's
model ID, not the direct `jev-latest` alias. The key must belong to the gateway;
Sedum does not automatically read `AI_GATEWAY_API_KEY`. See
[gateway setup and supported decision models](provider-typesafe.md#vercel-ai-gateway)
for SDK usage, billing, and compatibility requirements.

### OpenRouter decision models

To route Jev or another compatible System One model through OpenRouter:

```yaml
provider:
  name: openrouter
  model: typesafe/jev-1.13 # default; also accepts cloudflare/clef or cloudflare/clef-flash
```

Set `OPENROUTER_API_KEY` in your shell or project-root `.env`. The existing
`OPEN_ROUTER_API_KEY` spelling is also accepted. Process values override `.env`
across both names; within one source, `OPENROUTER_API_KEY` wins. Neither name
may appear in config variables, and neither is forwarded to test variables.

Sedum uses OpenRouter's [TypeSafe-compatible System One endpoint](https://openrouter.ai/docs/guides/community/typesafe-sdk)
at `https://openrouter.ai/api/v1/systemone`, not chat completions. Fully qualified
model IDs are passed unchanged. Other decision models must support Sedum's
Choice and Noul questions and response distributions; appearing in the
[decision rankings](https://openrouter.ai/rankings/decisions) is not a guarantee
of equivalent accuracy or limits. Direct Cloudflare Clef remains a separate provider.

This selection ignores `TYPESAFE_*` settings, including credentials. It applies
to runs, online validation, and affected-test selection. Cached
classifications are separated by provider and requested model. `sedum doctor`
sends a small, potentially billable request to the selected model.

Receipts identify `openrouter` and retain the returned model, token usage, and
`usage.cost`. Missing cost is unknown, not zero; direct Jev rates are never
applied to gateway calls. After any gateway retry, total cost remains unknown.
Other gateways can use the `TYPESAFE_BASE_URL` configuration above if they
implement the same System One protocol; a chat-only gateway is insufficient.

### Direct Cloudflare Clef

To use Cloudflare Workers AI Clef for text decisions, configure one of the two
supported models:

```yaml
provider:
  name: clef
  model: clef # or clef-flash
```

Then set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` in the invoking
environment or project-root `.env`. Cloudflare's conventional
`CLOUDFLARE_API_TOKEN` is accepted as an alias. Process values take precedence
over `.env` across both names; differing values for both names at the winning
level are rejected as ambiguous. Sedum builds the fixed Cloudflare account and
model route; Clef does not support a custom endpoint. Selecting Clef does not
change the default for other projects. See [Clef
provider](provider-clef.md) for scope, privacy, costs, and testing.

An absolute test `url` is unchanged. A relative test URL resolves against
`baseUrl` with standard URL semantics, and a missing test URL uses `baseUrl`
itself. A test with neither fails before the browser starts. Invalid config
errors name the file, source position, dotted key, and a concrete fix and exit
with code 3.

The `thresholds` settings control assertion verdicts. Locator and step
classification safety gates are deliberately not configurable. An explicit
JSON reporter writes to `reporterDir/<run-id>/result.json`; canonical progress
and result artifacts are always written under `outputDir/<run-id>/`.

## Step timeout

`stepTimeoutMs` is how long one step waits for the page before it fails. It
defaults to 5000 (5 seconds) and accepts whole milliseconds from 0 to 120000.
It covers every step that depends on the page settling:

- A `verify` step is judged again each time the page changes until its claim
  holds. A quoted-text check keeps reading a page that is mid-navigation.
- A `click` or `type` step whose target is not on the page yet is located
  again each time the page changes.
- A located target that is not ready yet, such as a disabled or covered button
  or a read-only field, is retried for at least 8 seconds, or for
  `stepTimeoutMs` when that is longer.

`0` judges and locates each step once. An explicit `wait up to 90 seconds
until …` step uses its own limit instead. The `SEDUM_VERIFY_GRACE_MS`
environment variable overrides the configured value for one run.

## Experimental affected selection

`affected.ignore` is an optional string array, empty by default. With
`sedum run --affected`, it combines **additively** with each repeatable
`--affected-ignore <glob>`; command-line entries do not replace config entries.
Unlike test discovery globs, these patterns are relative to the **Git repository
root**, even when the Sedum project is a subdirectory. Use POSIX `/` separators.
Dotfiles are included, `**` crosses directories, and a trailing `/` matches all
descendants. `*.lock` matches root lockfiles; `**/*.lock` also matches nested
ones. Empty or invalid patterns are rejected, as is `--affected-ignore` without
`--affected`. There are no automatic docs, config, or lockfile exclusions.

```yaml
# Deliberate examples, not recommended universal exclusions or secret redaction.
affected:
  ignore: ["docs/", "fixtures/generated/", ".env", "**/.env*"]
```

Filtering happens before patch reads. Changed tests and tests using changed
modules remain forced selections within the filtered candidate set, even when
their changed paths match an ignore. Full candidate test/module sources and
committed secrets in retained inputs still leave the machine; glob exclusions
are not a privacy guarantee. Dirty tracked state is refused even if ignored.

Selection uses committed `merge-base(base, pinned HEAD)..pinned HEAD`, not local
edits. Use a clean CI checkout, explicitly fetch `origin/main`, and pass
`--base origin/main`; Sedum never fetches or merges automatically. The default
selection cutoff is `--threshold 0.3`, separate from assertion `thresholds`.
Chunk scores aggregate by maximum, not calibrated whole-PR probability.
The 16 MiB retained patch and 256 planned request guards fail closed, alongside
28,000-byte single-question and 56,000-byte batch limits (64 questions for Clef).
See [Git-diff selection](cli.md#experimental-git-diff-selection) for lossless
chunking, costs, receipts, and the unverified accuracy caveat. Keep full-suite
CI; this experimental feature is not a mandatory gate.

## Screenshots

`screenshots` (default `true` for the direct TypeSafe API, `false` for
gateways, compatible services and Clef) sends viewport screenshots to the
provider: an outlined screenshot that checks each model-resolved target for
ambiguity, and a screenshot with each `verify` and `measure` step. `sedum run
--screenshots` and `--no-screenshots` override it for one run. Screenshots are
not redacted and are never sent for pages matched by `--sensitive-origin`. See
[Screenshots](provider-typesafe.md#screenshots) for cost and behavior.

## Vision fallback (opt-in)

Vision fallback is disabled by default. Enable it with `vision.enabled: true`
or `sedum run --vision`; `--no-vision` disables it for one run. It uses the
run's TypeSafe provider and key: Jev's image model (`jev-1.14.0`, the TypeSafe
images preview) reads a viewport screenshot in which every visible candidate
is boxed and labelled. It needs [screenshots](#screenshots), so it is
available on the direct TypeSafe API, where screenshots are on by default. A
run with vision on and screenshots off (Clef, a gateway, `screenshots: false`
or `--no-screenshots`) stops before tests start with
`vision_needs_screenshots`. `vision.model` and `vision.timeoutMs`, which
configured the earlier OpenRouter resolver, are rejected with a fix; delete
them.

Enabling vision sends **unredacted viewport screenshots** to TypeSafe. Use
non-sensitive pages. Text redaction does not redact screenshot pixels, and no
screenshot is sent for pages matched by `--sensitive-origin`.

With vision enabled, ambiguous clicks use visual evidence instead of the
default permissive Jev repeated-member pick. Existing deterministic resolution
still runs first. With vision disabled, Jev's behavior is unchanged. Core API
callers can explicitly override this via `repeatedMember`; an explicit
`modelPick: true` takes precedence over vision.

Only **clicks** can invoke vision: when Jev's pick among repeated controls is
ambiguous, or when Jev finds no matching element at all, for example a target
described by its picture. In the second case vision chooses among every
visible control or abstains, and an abstention keeps the step's `none`.
Missing controls, fills, assertions, and provider failures do not activate it.
Jev answers one Choice over the labels plus `ambiguous` and `no_match`, and
how many elements on screen fit the step. A label is used only at a
probability of at least 0.9, and only when Jev does not think that no element
(probability 0.3 or more) or several elements (0.5 or more) fit; otherwise
the step abstains. Unknown IDs and changed page versions are rejected;
execution still uses Sedum's normal target and actionability checks, and the
[target check](provider-typesafe.md#screenshots) still reviews the pick. Visual
layout changes without a DOM revision are not detected. Only fully visible,
unobscured controls are offered; fewer than two or more than 40 visible
controls leave the step unresolved.

There is at most one vision call per step, with no recovery after failure.
After vision is attempted, a stale action target fails without re-resolving.
Suppressing screenshots on sensitive pages does not restore permissive picks.
Existing Jev caching is unchanged; vision-selected targets are not cached.
HTML, Markdown, and CLI summaries identify vision fallback outcomes, the model,
trigger, and duration. A selected candidate is not a guarantee that its action
succeeded: the step verdict still reports execution separately. Text-model
confidence is not presented as vision confidence.
Usage summaries separate text and vision calls across all attempts, including
earlier retries. CLI usage is shown in interactive terminals or with `--costs`;
fallback details are also shown in non-interactive output. Vision calls are
priced at the Jev rate; see [Screenshots](provider-typesafe.md#screenshots).
Locator diagnostics include vision request duration and a safe failure
category (timeout, cancellation, connection, a rejected request, or an
invalid response). These fields are preserved in the canonical run result at
`steps[].locator.vision`; failures also appear in the step error message.
A rejected key or exhausted rate limit stops the run, as it does for every
other provider request.

The run summary says which vision model was enabled and on how many steps it
ran. A click that fails without vision being able to run says why, for
example because fewer than two controls were fully visible. `sedum doctor`
fails its `vision` check when vision is enabled but screenshots are off.
