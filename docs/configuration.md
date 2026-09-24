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
that request and return the TypeSafe System One response shape. These settings
do not make ordinary OpenAI-compatible chat endpoints compatible. These names
match the TypeSafe SDK. The URL defaults to TypeSafe and the model to
`jev-latest`; the API key is read from `TYPESAFE_API_KEY`. Set the URL and key
together for a custom service: Sedum sends that key to the configured URL.
Process values override the project `.env`. `TYPESAFE_API_KEY` is rejected
from `sedum.config.yaml`.

An absolute test `url` is unchanged. A relative test URL resolves against
`baseUrl` with standard URL semantics, and a missing test URL uses `baseUrl`
itself. A test with neither fails before the browser starts. Invalid config
errors name the file, source position, dotted key, and a concrete fix and exit
with code 3.

The `thresholds` settings control assertion verdicts. Locator and step
classification safety gates are deliberately not configurable. An explicit
JSON reporter writes to `reporterDir/<run-id>/result.json`; canonical progress
and result artifacts are always written under `outputDir/<run-id>/`.
