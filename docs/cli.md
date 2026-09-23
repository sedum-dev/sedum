# CLI commands

## `sedum init`

Run `sedum init` in the directory you want to turn into a Sedum project. It
creates `sedum.config.yaml`, `tests/example.test.yaml`, `.env.example`, and
`.gitignore` entries for `.env`, `.sedum/runs/`, and `.sedum/reports/`. The
classification cache at `.sedum/classifications.json` remains trackable.

The generated test signs in to the public SauceDemo sample store at
`https://www.saucedemo.com/` with `standard_user` and the public demo password
`secret_sauce`. `.env.example` supplies `SAUCE_PASSWORD`; the user must supply
their own `TYPESAFE_API_KEY`. Running the test calls the TypeSafe API and may
incur a charge. The generated config selects Chromium. If no matching browser
is installed, `init` prints `sedum browsers install chromium`; on Linux,
`sedum browsers install chromium --with-deps` also installs system libraries.
The command reports a missing key and prints the exact validation and run
commands. It does not contact the provider or install a browser itself.

On a fresh project, `init` asks no questions. Existing scaffold files are kept
as they are, including on repeated runs. An existing `.gitignore` is amended
only after confirmation in an interactive terminal. In a noninteractive shell,
the command prints any missing rules to add manually. A symlink or nonregular
file where a scaffold file belongs is an error. The small plant banner appears
only in an interactive color terminal; redirected and `NO_COLOR` output is plain.
If `.env.example` already exists, `init` keeps it and calls out the public
`SAUCE_PASSWORD=secret_sauce` value needed by the generated demo when that
variable is not already available.

```sh
mkdir my-sedum-tests && cd my-sedum-tests
sedum init
cp .env.example .env  # only when .env does not already exist
# Edit .env to set TYPESAFE_API_KEY. Install Chromium if init says it is missing.
sedum validate
sedum run tests/example.test.yaml
```

## `sedum doctor`

`sedum doctor` checks whether this project can run Sedum before starting a test. It reports each prerequisite as `PASS` or `FAIL`, with a fix for every failure: Node 20.19 or newer, valid config and `.env`, an installed browser, network and authenticated access to TypeSafe, and output directory write access. The authentication check sends one small request and may incur a provider charge. Doctor does not launch a browser or run tests.

`sedum doctor --json` writes one versioned JSON object, including when checks fail. Both output forms omit the API key and raw provider errors. The exit code is `0` when every check passes and `3` otherwise.

## `sedum run`

`sedum run [paths...]` runs the configured test directory, or the named test files and directories. Paths are relative to the project root. Directories are searched recursively; symlinked test files and directories are skipped or rejected. Explicit paths form the candidate set, while a run with no paths uses `tests.directory`, `tests.include`, and `tests.exclude` from configuration.

Filters apply after discovery: repeat `--include <glob>` or `--exclude <glob>` for project-relative paths, use `--labels smoke,auth` to require both YAML `tags`, and repeat `--name <text>` to match any case-insensitive substring of a test `id` or `description`. Excludes win. Bad test files are named in the result and valid files still run; the command exits 3 because the suite was incomplete. A selection with no valid tests also exits 3.

`--retries <n>` adds up to `n` whole-test attempts after a failed attempt. Each attempt starts a fresh browser context and repeats its `before`, `steps`, and `after` phases. The JSON result keeps every attempt; the terminal summary shows the outcome sequence. Model usage and cost include all attempts, while final pass/fail counts use the last attempt. `--timeout-minutes <minutes>` sets a run deadline; expiration records `run_timeout`, preserves partial results, and exits 3. It requests cancellation of the current browser or provider operation before finalizing. If an external operation does not unwind within ten seconds, the executable exits 3 and the last atomic `progress.json` may be the only available result.

`--env <name>` selects a configured environment. `--url-override <url>` replaces the origin of each test's initial URL while keeping its resolved path, query, and fragment; a later explicit `goto` step is unaffected. `--browser chrome|chromium`, `--slow <ms>`, `--output-dir <path>`, `--strict`, and `--costs` control browser and output behavior. `--headed` shows the browser and marks the element about to be clicked or filled with a browser overlay that does not change page content or intercept input. Canonical `progress.json` and `result.json` are always written under `<outputDir>/<run-id>/`.

The default `list` terminal reporter shows test results. Select `steps` for each completed step, or repeat `--reporter` to use both; `terminal` is an alias for `list`. Failed or flagged steps include a needs-attention block with their recorded sentence, source, reason, page context, and evidence status. Terminal output may use color in a TTY; redirected output is plain. `--reporter json` writes a separate final JSON result under `<reporterDir>/<run-id>/`, and `--reporter-dir <path>` selects that project-root-relative directory. You can combine JSON with terminal reporters. SED-41–43 add JUnit, markdown, and HTML formats.

## `sedum validate`

`sedum validate [paths...]` checks tests and modules without opening a browser, without a model key, and without spending tokens. That makes it cheap enough for a pre-commit hook and for every CI run.

Both commands find the project the same way `sedum run` does; see [project configuration](configuration.md). The project root is the folder of the nearest `sedum.config.yaml`, or the current directory when there is none. Test ids are therefore the same whichever folder you run from.

- **With no paths,** the commands check the tests that `sedum run` would run: the `*.test.yaml` files under `tests.directory` that match its `include` and `exclude` globs. They also check every `*.module.yaml` file under that directory.
- **With paths,** each path is resolved against the project root, as `sedum run` resolves an explicit file. A path can be a directory, a `*.test.yaml` file, or a `*.module.yaml` file. Directories are searched recursively. `node_modules` and dot-directories such as `.git` and `.sedum` are skipped, unless you name one directly.

It checks the following:

- **Format.** Every test and module is checked against the [v1 format](format.md): keys, types, data, placeholders, and a `type` step that names exactly one value.
- **Module calls.** Every `use:` call is resolved: missing files, cycles, depth, and arguments.
- **Sentences.** Every sentence in a test or a reachable module is classified into one operation (`click`, `type`, `verify`, …).
- **Identities.** Every test must have a unique identity. That identity is its explicit `id`, or else its path relative to the project root.
- **Entry URL.** The URL each test opens is resolved against the configured `baseUrl`, exactly as `sedum run` resolves it. A test with no `url` and no `baseUrl`, or with a relative `url` and no `baseUrl`, is an error.
- **Configuration.** An invalid `sedum.config.yaml` is reported with its position and exits `3`.

It reports every problem it finds in one run, not only the first, as `path:line:col` followed by a fix:

```text
tests/checkout.test.yaml:9:5: error invalid_operand: Name one value, such as {{key}} or "{{user}}@example.com", and a field. Sentence: "type {{first}} then {{last}} in the name field".
  Fix: Use one value, address, key, or binding in the supported form.
tests/checkout.test.yaml:11:5: not checked offline: Classification is unavailable offline for this sentence (cache: absent). Sentence: "add the cheapest item to the basket".
  Fix: Rephrase with a supported verb, or run `sedum validate --online` with TYPESAFE_API_KEY set and commit .sedum/classifications.json.
Checked 6 tests and 2 modules: 1 error, 1 sentence not checked offline.
```

### Offline by default

Validation classifies sentences using built-in patterns and the committed `.sedum/classifications.json` only; see [step classification](classification.md). It does not read `TYPESAFE_API_KEY` or the project `.env`, does not resolve `$ENV` values (an unset variable is fine), and does not write any file. Because it never opens `.env`, a malformed or unreadable `.env` is reported by `sedum run` and `--online`, not by offline validation. A sentence it cannot classify this way is reported as **not checked offline** and fails the check. Sedum cannot confirm what that step will do, so it never reports it as valid.

To resolve such a sentence, either rephrase it with an obvious supported verb, or classify it once with the model:

```sh
TYPESAFE_API_KEY=... sedum validate --online
git add .sedum/classifications.json
```

`--online` takes the key from the process environment or the project-root `.env`, as `sedum run` does. It sends only the sentences the cache cannot answer. It writes accepted answers to `.sedum/classifications.json`; commit that file so CI can validate offline. If you ignore `.sedum/` for run output, keep the cache tracked:

```gitignore
.sedum/*
!.sedum/classifications.json
```

A module that no test uses is still checked for format and its own sentences. Its own `use:` calls are checked when a test reaches it, and the summary says so.

### Exit codes

| Exit | Meaning                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Every test and module is valid, and every sentence was classified.                                                                                                                                                                 |
| `1`  | Invalid content was found, or some sentences were not checked offline.                                                                                                                                                             |
| `3`  | The check could not run: an invalid `sedum.config.yaml`, a missing path, a path outside the project root, a file that is not a test or module, no files found, an unreadable file, or a provider or cache failure with `--online`. |

When both a `3` problem and a finding occur, the exit is `3`. Warnings, such as a data value YAML would change, never affect the exit code.

## `sedum list`

`sedum list [paths...]` prints the discovered tests with their id, tags, and path. It only parses files, so it needs no classification cache or key.

```text
ID                    TAGS        PATH
valid/cart.test.yaml  -           valid/cart.test.yaml
login                 smoke,auth  valid/login.test.yaml
2 tests
```

A file that cannot be listed is named on stderr with its first problem. Run `sedum validate` on it for the full list.

`sedum list --json` prints only JSON on stdout:

```json
{
  "schemaVersion": 1,
  "tests": [
    {
      "id": "login",
      "idSource": "explicit",
      "file": "valid/login.test.yaml",
      "description": "a customer signs in",
      "tags": ["smoke", "auth"]
    }
  ],
  "invalid": [
    {
      "file": "broken/typo.test.yaml",
      "diagnostics": [
        {
          "severity": "error",
          "code": "unknown_key",
          "line": 4,
          "col": 1,
          "message": "Unknown top-level key `stepz`.",
          "fix": "Did you mean `steps`?"
        }
      ]
    }
  ]
}
```

In the JSON:

- `idSource` is `explicit` for an `id` key and `path` for a path identity.
- `description` is `null` when absent.
- `file` is relative to the project root and uses `/` on every OS.
- Test entries never include test data, URLs, `meta`, or step sentences. Diagnostics quote only what the file already contains.
- Fields may be added within `schemaVersion: 1`. A change that removes or renames a field, or changes what a field means, bumps the version.

`list` exits `0` when every discovered file was listed, including when there are none. It exits `1` when some files could not be listed, and `3` for an invalid config or a bad path.

## In CI and pre-commit

Neither command needs a browser or a key:

```yaml
# .github/workflows/tests.yml
- run: npx sedum validate
```

```sh
# .git/hooks/pre-commit
npx sedum validate || exit 1
```
