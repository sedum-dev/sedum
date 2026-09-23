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

Sedum reads at most one dotenv file: `<project-root>/.env`. It never searches a
test directory, child, parent project, or sibling project for secrets. Values
from the invoking process override `.env`; both override config variables with
the same name. `TYPESAFE_API_KEY` is accepted only from the process or this
`.env`, never from `sedum.config.yaml`. `.env` is ignored by Git and should not
be committed.

An absolute test `url` is unchanged. A relative test URL resolves against
`baseUrl` with standard URL semantics, and a missing test URL uses `baseUrl`
itself. A test with neither fails before the browser starts. Invalid config
errors name the file, source position, dotted key, and a concrete fix and exit
with code 3.

The assertion thresholds are the user-facing SED-13 policy. Resolver and step
classification safety gates are deliberately not configurable. `reporterDir`
is reserved for the reporter implementations; canonical progress and result
artifacts are written under `outputDir/<run-id>/`.
