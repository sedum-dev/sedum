# CLI commands

## `sedum init`

Run `sedum init` in the directory you want to turn into a Sedum project. It
creates `sedum.config.yaml`, `tests/example.test.yaml`, `.env.example`, and
`.gitignore` entries for `.env`, `.sedum/runs/`, and `.sedum/reports/`. The
classification cache at `.sedum/classifications.json` remains trackable.

The generated test signs in to the public SauceDemo sample store at
`https://www.saucedemo.com/` with `standard_user` and the public demo password
`secret_sauce`. `.env.example` supplies `SAUCE_PASSWORD`; the user must supply
their own provider key. Set `TYPESAFE_API_KEY` to use TypeSafe, or set
`TYPESAFE_BASE_URL` alongside the compatible provider's `TYPESAFE_API_KEY`
([details](configuration.md)). Running the test calls
the configured provider and may incur a charge. The generated config selects
Chromium. If no matching browser is installed, `init` prints
`sedum browsers install chromium`; on Linux,
`sedum browsers install chromium --with-deps` also installs system libraries.
The command reports a missing key, previews the YAML test it creates, and
prints a headed run command. It does not contact the provider or install a
browser itself.

On a fresh project, `init` asks no questions. Existing scaffold files are kept
as they are, including on repeated runs. An existing `.gitignore` is amended
only after confirmation in an interactive terminal. In a noninteractive shell,
the command prints any missing rules to add manually. A symlink or nonregular
file where a scaffold file belongs is an error. The Sedum wordmark appears
only in an interactive color terminal; redirected and `NO_COLOR` output is plain.
If `.env.example` already exists, `init` keeps it and calls out the public
`SAUCE_PASSWORD=secret_sauce` value needed by the generated demo when that
variable is not already available.

```sh
mkdir my-sedum-tests && cd my-sedum-tests
sedum init
cp .env.example .env  # only when .env does not already exist
# Set TYPESAFE_API_KEY in .env, or configure a compatible provider. Install Chromium if needed.
sedum run tests/example.test.yaml --headed
```

## `sedum doctor`

`sedum doctor` checks whether this project can run Sedum before starting a test. It reports each prerequisite as `PASS` or `FAIL`, with a fix for every failure: Node 20.19 or newer, valid config and `.env`, an installed browser, network and authenticated access to the configured model provider, and output directory write access. The authentication check sends one small request and may incur a provider charge. Doctor does not launch a browser or run tests.

`sedum doctor --json` writes one versioned JSON object, including when checks fail. Both output forms omit the API key and raw provider errors. The exit code is `0` when every check passes and `3` otherwise.

## `sedum browsers install`

Sedum uses `playwright-core` and does not download a browser during a test run. Install the matching managed Chromium binary explicitly:

```sh
sedum browsers install chromium
```

On supported Linux environments, install system dependencies as well:

```sh
sedum browsers install chromium --with-deps
```

Sedum prefers an installed Google Chrome channel when available. If Chrome is not available, it uses the matching Playwright-managed Chromium binary. An arbitrary Chromium executable on `PATH` is not used as a fallback.

## `sedum run`

`sedum run [paths...]` runs the configured test directory, or the named test files and directories. Paths are relative to the project root. Directories are searched recursively; symlinked test files and directories are skipped or rejected. Explicit paths form the candidate set, while a run with no paths uses `tests.directory`, `tests.include`, and `tests.exclude` from configuration.

Filters apply after discovery: repeat `--include <glob>` or `--exclude <glob>` for project-relative paths, use `--labels smoke,auth` to require both YAML `tags`, and repeat `--name <text>` to match any case-insensitive substring of a test `id` or `description`. Excludes win. Bad test files are named in the result and valid files still run; the command exits 3 because the suite was incomplete. A selection with no valid tests also exits 3.

`--retries <n>` adds up to `n` whole-test attempts after a failed attempt. Each attempt starts a fresh browser context and repeats its `before`, `steps`, and `after` phases. The JSON result keeps every attempt; the terminal summary shows the outcome sequence. Model usage and cost include all attempts, while final pass/fail counts use the last attempt. `--timeout-minutes <minutes>` sets a run deadline; expiration records `run_timeout`, preserves partial results, and exits 3. It requests cancellation of the current browser or provider operation before finalizing. If an external operation does not unwind within ten seconds, the executable exits 3 and the last atomic `progress.json` may be the only available result.

### Parallel runs and sharding

`--parallel <n|auto>` runs selected tests in up to `n` lanes at once (1 to 64). `auto` uses half the logical CPU cores, as Playwright Test does. The default is `1`, so behavior and provider cost only change when you ask. Each lane keeps one browser. Every attempt gets a fresh browser context, and a lane restarts its browser after a browser or operational error. A lane runs a test's retries before it takes the next test. The result lists tests in selection order, whatever order they finish in, and records each attempt's `lane`.

```sh
sedum run --parallel auto
sedum run --parallel 4 --retries 1
```

Tests that share backend state can keep it apart with values Sedum adds to each attempt's environment:

- `SEDUM_PARALLEL_INDEX` is the lane, from 0.
- `SEDUM_SHARD_INDEX` is the shard, from 1.
- `SEDUM_ATTEMPT_KEY` is a short random value that is new for every attempt, including retries.

Like other environment values, they are hidden from the model and from reports:

```yaml
data:
  email: qa+${SEDUM_ATTEMPT_KEY}@example.com
```

`--provider-concurrency <n>` caps model-provider requests in flight across all lanes (1 to 32). It defaults to `min(4, 2 × lanes)`. When the provider returns HTTP 429, every lane pauses until its `Retry-After`, up to 60 seconds for each pause. Requests then resume one at a time, and concurrency climbs back by one for each success. Waiting for a slot or a pause does not use up the 30-second request deadline or the three-attempt retry limit. A call that is still being rate limited after five minutes stops the run with `provider_rate_limited` (exit 3); lower `--parallel` or `--provider-concurrency`, or retry later. The run deadline and Ctrl-C end any wait sooner.

`--shard-index <i> --shard-count <n>` runs one of `n` deterministic slices of the selection; the index starts at 1. Sharding happens after paths and filters, so every job must use the same paths, filters, and config. As in Jest and Vitest, tests are ordered by a hash of their identity (explicit `id`, else path) and cut into contiguous slices:

- Shard sizes differ by at most one.
- The split does not depend on discovery order.
- Adding or removing one test moves at most `n − 1` others between shards.

Each invalid test file is reported by exactly one shard. A shard that receives no tests fails with `empty_shard` (exit 3), so keep `--shard-count` at or below the suite size. Each shard writes its own result; merging shard results is not supported yet.

```yaml
# .github/workflows/e2e.yml
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: npx sedum run --parallel 2 --shard-index ${{ matrix.shard }} --shard-count 4
```

With more than one lane, the `list` reporter prints one line per finished test with a counter (`[3/20] test PASSED …`). A retried test gets one line, showing the outcome that counts and its attempt count. The `steps` reporter prints each test's steps as one block when that test finishes, so output from tests running at the same time never interleaves. The summary adds the lane count, the shard, time spent in provider rate-limit pauses, and any locator cache write conflicts.

`--env <name>` selects a configured environment. `--url-override <url>` replaces the origin of each test's initial URL while keeping its resolved path, query, and fragment; a later explicit `goto` step is unaffected. `--browser chrome|chromium`, `--slow <ms>`, `--output-dir <path>`, `--strict`, and `--costs` control browser and output behavior. `--headed` shows the browser and marks the element about to be clicked or filled with a browser overlay that does not change page content or intercept input. Canonical `progress.json`, `result.json`, and the offline `report.html` are written under `<outputDir>/<run-id>/`.

### Output and exit codes

`sedum --help` lists the available commands; every command has its own `--help`. `sedum run` prints one ordered result line per test and aggregate verdict counts, plus separate `low_confidence` and `contradiction` counts. Terminals receive colored result labels and transient progress. Redirected output contains no ANSI or cursor controls and does not truncate paths or diagnostics.

Run exits are `0` for a pass (including a flagged pass by default), `1` for a failed test, `2` for a flagged pass under `--strict`, and `3` when the command or run could not produce a trustworthy verdict. `--strict` never changes the canonical verdict or flags. Model tokens and costs are shown automatically in a terminal; pass `--costs` to include them in redirected output.

The default `list` terminal reporter shows test results. Select `steps` for each completed step, or repeat `--reporter` (or give a comma-separated list such as `--reporter list,junit`) to use several; `terminal` is an alias for `list`. Failed or flagged steps include a needs-attention block with their recorded sentence, source, reason, page context, and evidence status. Terminal output may use color in a TTY; redirected output is plain. `--reporter json` writes a separate final JSON result under `<reporterDir>/<run-id>/`, and `--reporter-dir <path>` selects that project-root-relative directory. You can combine JSON with terminal reporters. The JSON copy is the canonical `RunResult` unchanged and validates against `@sedum-dev/core/run-result.schema.json`.

`--reporter junit` writes `<reporterDir>/<run-id>/junit.xml` for CI test views (GitLab, Jenkins, CircleCI, Azure DevOps, or a JUnit action on GitHub); it writes no JSON copy unless you also select `json` or pass `--reporter-dir`. When the reporter and output directories are the same, it goes in the run directory. A flagged pass is a passing testcase with its flags as properties and output; `--strict` adds a failure to it, so the file matches the exit code. See [running in CI](ci.md) for the full mapping and pipeline examples. When `markdown` is the only other reporter, stdout prints `junit <path>` after the `markdown <path>` line; the run summary lists it otherwise.

The HTML file is created for every run with an authoritative result; open it directly in a browser, without a server.

`--reporter markdown` also writes `report.md` for a coding agent to read, always in the canonical `<outputDir>/<run-id>/` next to `result.json`; `--reporter-dir` does not move it. When it is the only reporter, stdout is a single line, `markdown <path>`; otherwise the run summary lists that line with the other artifacts. The report opens with the verdict and a flow table sorted failed, incomplete, flagged, then passed. Then, for each failed, flagged, errored or interrupted step, it gives the sentence, `file:line:col`, score against the fail and pass lines, contradiction against its cutoff, page URL and title, the locator's weighed candidates including `(no match)`, the full recorded browser error and call log, the judged page excerpt, a relative link to the step's frame, and a rerun command that works from anywhere in the project. Passed flows collapse to the checks that held. Page text and browser errors are escaped or fenced and labeled untrusted, so page content cannot add headings, links or images to the report. The report links frames rather than embedding them; the frames can still show private page pixels.

Frames are stored per attempt as `evidence/<attempt-key>/<frame>.jpg` inside the run directory, and every run and attempt gets a new directory. Sedum never deletes another run's files, so parallel workers, retries and consecutive CI runs can share one output directory. Nothing expires automatically: remove a run with `rm -rf <outputDir>/<run-id>` (and `<reporterDir>/<run-id>` if you wrote a JSON copy or `junit.xml` there), and keep `.sedum/runs/` out of source control.

The HTML report includes light and dark themes, failure and flagged-flow filters, per-assertion scores and decision lines, all retry attempts, and a receipt from the recorded model calls. A missing cost is shown as unknown rather than zero. `--replay` captures step frames and embeds them in `report.html`; without it the report contains no frame bytes. Captured frames can contain private page pixels, so use `--sensitive-origin` or omit replay on sensitive pages. Frames show the visible page, while assertion grades come from the recorded judgement and judged page excerpt. The file contains its own styles, fonts, scripts, and optional frames and makes no network requests.

## `sedum validate`

`sedum validate [paths...]` checks tests and modules without opening a browser, without a model key, and without spending tokens. That makes it cheap enough for a pre-commit hook and for every CI run.

Both commands find the project the same way `sedum run` does; see [project configuration](configuration.md). The project root is the folder of the nearest `sedum.config.yaml`, or the current directory when there is none. Test ids are therefore the same whichever folder you run from.

- **With no paths,** the commands check the tests that `sedum run` would run: the `*.test.yaml` files under `tests.directory` that match its `include` and `exclude` globs. They also check every `*.module.yaml` file under that directory.
- **With paths,** each path is resolved against the project root, as `sedum run` resolves an explicit file. A path can be a directory, a `*.test.yaml` file, or a `*.module.yaml` file. Directories are searched recursively. `node_modules` and dot-directories such as `.git` and `.sedum` are skipped, unless you name one directly.

It checks the following:

- **Format.** Every test and module is checked against the [test file format](format.md): keys, types, data, placeholders, and a `type` step that names exactly one value.
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
  Fix: Rephrase with a supported verb, or run `sedum validate --online` with a provider API key configured and commit .sedum/classifications.json.
Checked 6 tests and 2 modules: 1 error, 1 sentence not checked offline.
```

### Offline by default

Validation classifies sentences using built-in patterns and the committed `.sedum/classifications.json` only; see [step classification](classification.md). It does not read provider credentials or the project `.env`, does not resolve `$ENV` values (an unset variable is fine), and does not write any file. Because it never opens `.env`, a malformed or unreadable `.env` is reported by `sedum run` and `--online`, not by offline validation. A sentence it cannot classify this way is reported as **not checked offline** and fails the check. Sedum cannot confirm what that step will do, so it never reports it as valid.

To resolve such a sentence, either rephrase it with an obvious supported verb, or classify it once with the model:

```sh
TYPESAFE_API_KEY=... sedum validate --online
git add .sedum/classifications.json
```

`--online` takes the key from the process environment or the project-root `.env`, as `sedum run` does. It sends only the sentences the cache cannot answer. It writes accepted answers to `.sedum/classifications.json`; commit that file so CI can validate offline.

For a compatible provider, also set `TYPESAFE_BASE_URL` and optionally
`TYPESAFE_DEFAULT_MODEL`; use that provider's key as `TYPESAFE_API_KEY`.

If you ignore `.sedum/` for run output, keep the cache tracked:

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

Neither command needs a browser or a key. These examples assume `sedum-cli` is
a dev dependency of the project; see [running in CI](ci.md#install-sedum-in-the-project).

```yaml
# .github/workflows/tests.yml
- run: npx sedum validate
```

```sh
# .git/hooks/pre-commit
npx sedum validate || exit 1
```
