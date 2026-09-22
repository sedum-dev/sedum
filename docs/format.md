# Test file format

A test is one `*.test.yaml` file. Its path relative to the repository is its identity; use an optional `id` to keep that identity stable across renames. Use `description` for a human-readable title. You can omit `sedum`; it means format version 1. `sedum: 1` is also accepted.

```yaml
description: a customer signs in
url: https://www.saucedemo.com/
data:
  user: standard_user
  password: $SAUCE_PASSWORD
steps:
  - type {{user}} in the username field
  - type {{password}} in the password field
  - click the login button
  - verify a list of products with prices is shown
```

`steps` is required and contains at least one sentence. Optional `before` and `after` lists use the same step shape. A `use:` entry names a `*.module.yaml` file; module loading and execution arrive with SED-29. `tags` is a list of strings and `meta` is a free-form mapping. `goal`, top-level `verify`, `name`, `fileType`, and `run:` are not accepted by the v1 loader.

`data` values can be strings, numbers, booleans, or null. Quote a value when its written characters matter, such as a postcode with a leading zero. `$VAR` and `${VAR}` read environment variables when that test runs; `$$` writes a literal dollar. They are not resolved while tests are discovered or checked for format errors. An unset variable therefore affects only a selected run. Environment-derived values are treated as secrets in displays and model requests.

In a sentence, `{{name}}` refers to a `data` key, including inside a double-quoted literal. The model receives a sentence with placeholder names, never the data values. A `type` step must name exactly one value; `type {{first}} then {{last}}` is an error. Format diagnostics show a file, line, column, and fix. A full offline validation also needs sentence classification and module checks; a format-only check does not claim those checks passed.
