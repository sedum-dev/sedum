# Project configuration

Sedum looks for the nearest `sedum.config.yaml` in the current directory or
one of its parents. The folder containing that file is the project root. If no
file exists, the current directory is the root and the defaults below apply.
Paths and test globs are always relative to that root.

```yaml
tests:
  directory: tests
  include: ["**/*.test.yaml"]
  exclude: []

browser: chrome
viewport: { width: 1280, height: 900 }
thresholds:
  verify: 0.75
  lowConfidenceBand: 0.15
  contradiction: 0.5

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
`*.test.yaml` files under `tests.directory`, applies the include/exclude globs,
and runs the sorted result. Symlinked directories are not followed. An explicit
`sedum run path/to/file.test.yaml` remains supported.

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
the same name. `TYPESAFE_API_KEY` is accepted only from the process or this
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

An absolute test `url` is unchanged. A relative test URL resolves against
`baseUrl` with standard URL semantics, and a missing test URL uses `baseUrl`
itself. A test with neither fails before the browser starts. Invalid config
errors name the file, source position, dotted key, and a concrete fix and exit
with code 3.

The `thresholds` settings control assertion verdicts, not locator confidence
or step classification. An explicit JSON reporter writes to
`reporterDir/<run-id>/result.json`; canonical progress and result artifacts are
always written under `outputDir/<run-id>/`.

## Locator ambiguity

```yaml
locator:
  ambiguity: reject # or first
```

This is a global, provider-independent policy for click, fill, and remembered
element resolution. There are three distinct behaviors:

- **Omitted** (including `locator: {}`): preserves existing behavior, which
  allows model picks among repeated controls, including low-confidence picks.
  Omission is **not** equivalent to explicit `reject`.
- **`reject`**: requires a uniquely justified target. Disables the legacy
  repeated-control model-pick and other permissive duplicate-selection options.
- **`first`**: uses the same strict behavior, except that when multiple eligible
  controls demonstrably satisfy the entire request, it selects the first one
  in candidate collection order. It does not use provider ranking, generated
  candidate IDs, visual position, CSS order, or tab order.

Collection follows depth-first DOM order in the active modal, if present,
otherwise the document body. Open shadow roots are visited at their host before
the host's light-DOM children. Hidden, disabled, and operation-ineligible controls
cannot become a permissive match. Closed shadow roots and iframe contents are
not added by this policy.

The permissive matching set is intentionally conservative: a complete literal
control name (optionally followed by its control kind), or an explicit kind
such as `checkbox`. Case and whitespace are normalized. Optional `in`, `under`,
`inside`, or `within` scopes must exactly name an observed section or landmark;
`for Alice` must exactly match a complete observed peer label. Thus `click Delete
in the footer` considers only footer matches, not every Delete on the page.
`click Delete button` excludes links named Delete. No leftover adjectives,
negations, or other qualifiers are discarded. Unsupported wording remains on
the normal strict resolution path; `first` does not promise to resolve every
natural-language ambiguity. Existing ordinal, price, and unique contextual
resolution still apply, so `click the second Delete` does not become the first.
For fill steps, matching uses the target sentence with the value operand removed.

Permissive selection requires a valid non-`none` provider choice in the matching
set, at least 0.75 combined probability on that set in the final comparable
decision, and provider confidence of at least 0.3 when supplied. A split margin
within that set is allowed; general low confidence is not. Provider failures,
no-match responses, incomplete observations, or stale targets do not trigger
`first`. Fresh-target validation and the executor's actionability checks still
run; Sedum does not skip a blocked first match to try another.

Both explicit policies bypass locator cache reads and writes: existing cache
entries establish identity, not uniqueness or current first-match order. Cache
diagnostics report `ambiguity_policy`. Locator diagnostics and canonical JSON
step results expose `locator.gate: ambiguity_first` when the permissive policy
selected a target, including if a later freshness/actionability check failed.
The step outcome must still be checked to determine whether an action executed.
