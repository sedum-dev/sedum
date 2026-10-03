# Project configuration

Sedum looks for the nearest `sedum.config.yaml` in the current directory or
one of its parents. The folder containing that file is the project root. If no
file exists, the current directory is the root and the defaults below apply.
Paths and test globs are always relative to that root.

```yaml
tests:
  directory: tests
  include: ["**/*.test.ts", "**/*.test.yaml"]
  exclude: []

browser: chrome
viewport: { width: 1280, height: 900 }
thresholds:
  verify: 0.75
  lowConfidenceBand: 0.15
  contradiction: 0.5

# Optional. TypeSafe with jev-latest remains the default.
# provider: { name: clef, model: clef }

vision:
  enabled: false
  model: google/gemini-3.8-flash
  timeoutMs: 10000

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
```

Every key is optional. With no positional file, `sedum run` discovers regular
`*.test.ts` and `*.test.yaml` files under `tests.directory`, applies the
include/exclude globs, and runs the sorted result. Each `test()` in a
`*.test.ts` file is one test. Symlinked directories are not followed. An
explicit `sedum run path/to/file.test.ts` remains supported.

Settings resolve from defaults, then the top-level config, then the selected
named environment, then explicit command overrides. Named environments may
override only `baseUrl` and `variables`. Nested settings merge by field, so an
override of viewport width retains the configured height.
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
change the default for other projects and does not enable vision. See [Clef
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

## Vision fallback (opt-in)

Vision fallback is disabled by default. Enable it with `vision.enabled: true`
or `sedum run --vision`; `--no-vision` disables it, and `--vision-model`
overrides the configured model. An enabled run requires the exact credential
`OPEN_ROUTER_API_KEY` from the invoking process or project-root `.env`. The
credential is never accepted in YAML. The default model is
`google/gemini-3.8-flash`, with a 10-second request timeout.

Enabling vision sends **unredacted viewport screenshots** to OpenRouter and the
configured model. Use non-sensitive pages. Text redaction does
not redact screenshot pixels.

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
The model selects a labeled existing candidate or abstains. Unknown IDs and
changed page versions are rejected; execution still uses Sedum's normal target
and actionability checks. Visual layout changes without a DOM revision are not
detected. Only fully visible, unobscured controls are offered; fewer than two
or more than 40 visible controls leave the step unresolved.

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
fallback details are also shown in non-interactive output.
Vision costs use OpenRouter's reported `usage.cost`, without inventing separate
input/output dollar charges. Missing costs keep the total incomplete while the
known subtotal remains visible. These are spend reports, not budget limits.
Locator diagnostics include vision request duration and a safe failure category
(HTTP error/status, timeout, cancellation, connection, malformed response,
invalid selection, or truncation). These fields are preserved in the canonical
run result at `steps[].locator.vision`; failures also appear in the step error
message. Upstream error bodies are not retained.
An HTTP 429 means rate limiting, not a model abstention; the step remains
unresolved and is not retried.

When vision is enabled, `sedum run` checks `OPEN_ROUTER_API_KEY` once before
tests start, using OpenRouter's unbilled key endpoint. The run summary says
which vision model was enabled and on how many steps it ran, and warns when
OpenRouter rejected the key. A click that fails without vision being able
to run says why, for example because fewer than two controls were fully
visible. `sedum
doctor` checks the key when `vision.enabled` is true, or with
`sedum doctor --vision`.
