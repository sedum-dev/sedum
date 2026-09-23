# CLI commands

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
