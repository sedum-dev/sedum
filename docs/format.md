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

`steps` is required and contains at least one sentence. Optional `before` and `after` lists use the same step shape. A `use:` entry names a `*.module.yaml` file. `tags` is a list of strings and `meta` is a free-form mapping. `name`, `fileType`, and `run:` are not accepted. `goal` and top-level `verify` are not accepted yet; goal-based tests are coming soon.

## Reusable modules and hooks

A module contains only a required `parameters` list and a nonempty `steps` list. Parameters are unique required names with the same spelling rules as data keys. Calls supply every parameter once under `with` and cannot supply extra names. A module sentence sees its own parameters and its earlier remembered values; caller data is available only through an explicit `with` argument. Nested `use` calls receive the phase of their caller.

```yaml
# modules/login.module.yaml
parameters: [username, password]
steps:
  - type {{username}} into the Username field
  - type {{password}} into the Password field
  - click the Login button
```

```yaml
# login.test.yaml
url: https://example.test/login
data:
  username: alice
before:
  - use: ./modules/login.module.yaml
    with:
      username: "{{username}}"
      password: $LOGIN_PASSWORD
steps:
  - verify the products page is shown
after:
  - click the logout button
```

Module paths are relative to the file containing the `use` entry. Canonical targets must stay inside the repository. Nested modules are limited to 32 call edges; a cycle is an error. Missing files, invalid modules, cycles, depth overflow, and bad argument names fail validation before browser launch. A result's source stack runs from the test call site through nested module calls to the executed sentence.

`with` values accept strings, numbers, booleans, and null. Strings may interpolate caller `{{name}}` values and use `$VAR`, `${VAR}`, or `$$` for explicit environment access. A module occurrence evaluates its arguments when reached, so an earlier remembered value may be passed to a later call. An unavailable remembered value fails that call; an unset environment variable is an operational error. Environment-derived values and bindings made from them stay opaque in model requests and reports.

Navigation precedes `before`. A failed `before` skips `steps`; `after` still runs after an ordinary setup or body pass or failure while the page remains usable. Teardown continues through later entries after one fails. The first failure remains primary, and later teardown failures are retained separately. A teardown failure fails an otherwise passing attempt. External cancellation or a lost browser cannot guarantee cleanup.

The [local fixture flows](../fixtures/README.md) show two tests sharing one UI login module. Signing in through an API or a saved session is not supported yet; use a UI login module.

`data` values can be strings, numbers, booleans, or null. Quote a value when its written characters matter, such as a postcode with a leading zero. `$VAR` and `${VAR}` read environment variables when that test runs; `$$` writes a literal dollar. They are not resolved while tests are discovered or checked for format errors. An unset variable therefore affects only a selected run. Environment-derived values are treated as secrets in displays and model requests.

In a sentence, `{{name}}` refers to a `data` key or an earlier remembered binding, including inside a double-quoted literal. `remember the price shown as {{price}}` reads the selected page target's text (nonempty, at most 4096 characters); `remember the page text as {{name}}` reads the whole page. An earlier remembered value can be passed to a later module call and can appear in a Judge assertion. Environment-derived values remain placeholders in model input, even when an application echoes a credential into remembered page text. A binding name cannot replace declared data or an earlier binding. A `type` step must name exactly one value; `type {{first}} then {{last}}` is an error. Format diagnostics show a file, line, column, and fix. A full offline validation also needs sentence classification and module checks; a format-only check does not claim those checks passed.
