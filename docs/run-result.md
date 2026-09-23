# RunResult v1 and live progress

`@sedum-dev/core/run-result.schema.json` is the Draft 2020-12 schema generated from the same Zod definition used to validate every published snapshot. The schema ID is `https://sedum.dev/schemas/run-result/v1`. SED-29 revises the unpublished v1 contract while `@sedum-dev/core` is private and at `0.0.0`: every attempt now has required `problems` and nullable `primaryProblemId`. This is an intentional pre-release revision, not a backward compatible change. After v1 is published, incompatible changes require a new major schema version. Consumers should reject unknown major versions.

Each attempt problem has a unique ID, consecutive attempt-local ordinal, phase, ordered source stack, outcome, typed error, and an origin of `step` or `module_binding`. A step problem links its executed step; a module binding problem has `stepId: null` because no sentence ran. The first encountered problem is primary. A failed setup or body stays primary even if later teardown reports an operational error. A primary operational error leaves the verdict null. Executed steps retain their own phase and source stack; there are no synthetic module-call steps.

For a syntactically valid `sedum run`, the CLI resolves project configuration,
then creates `<outputDir>/<run-id>/progress.json` before provider setup or test
loading and prints its path. The default `outputDir` is `.sedum/runs`. Config
must be read first because it chooses this location; an invalid config uses the
default location for its terminal operational result when that directory is
writable. Each update replaces the file atomically with a complete, validated
`RunResult`; pollers can parse it at any point. `result.json` is written from
the terminal snapshot. A setup or execution error has `state: "error"`, a typed
`error`, and `verdict: null`; already completed tests and steps remain. Zero
executed tests are never a pass. A passed step with `low_confidence` or
`contradiction` stays passed; a future strict gate may change an exit status or
JUnit mapping, not the canonical verdict.

SIGINT and SIGTERM received while a run is active request cancellation. The CLI waits for the current operation to unwind, then writes `state: "interrupted"`, `verdict: null`, and a terminal `result.json` before exiting with the conventional signal exit code. Once the terminal outcome is committed, late signals are ignored while its final files are written so the process exit and persisted state cannot disagree. An interrupted provider request may have incurred unreported usage; its call is retained with unknown cost, so a receipt never presents that attempt as free.

The CLI derives ordinary run exits from this result: completed clean pass `0`,
completed flagged pass `0` or `2` with `--strict`, failed `1`, and a null or
untrustworthy verdict `3`. Strict mode changes only that shell gate. Terminal
and redirected summaries show the same ordered test identities, verdict/state,
flags, and totals; only ANSI/live updates and the default visibility of
token/cost lines differ.

If the output sink itself fails, exit `3` is reported from the latest validated
in-memory snapshot. Sedum names the intended path and does not advertise an
earlier progress file as an authoritative final result. This is the sole case
where terminal artifact persistence cannot be promised through the failed
destination.

The model has ordered tests, whole-test attempts, steps, and observation attempts. Only the selected terminal attempt contributes to final test/step outcome counts; all attempts contribute to model usage and cost. Unknown actual cost is `null`, not zero. Each model call carries its model ID, tokens, rate provenance, and actual cost when known. SED-33 populates the whole-test attempt slots; SED-65 owns bounded observation retries inside a step. SED-14 can populate the explicit locator cache event slot; no cache hit is inferred from an absence of model calls.

For directory runs, `selectedTestCount` and `totals.selectedTests` include tests selected before execution, including those not reached after an interruption. `discoveryProblems` names malformed or unreadable candidate files with safe relative paths and fixes; valid selected files may still execute, but a run with discovery problems is incomplete and exits 3. Whole-test retries create distinct attempts. Classification calls made for a retry belong to that attempt's `calls`; step calls remain on their steps. Usage and cost totals include both kinds of call from every attempt.

Markdown and HTML reporters (SED-42/43) consume this same result: verdicts and flags, source positions, safe details, exact scores and thresholds, ranked candidates including `(no match)`, page URL/title tied to an accepted observation, evidence status/path, timings, and usage/cost are all present. `--replay` adds a referenced frame per executed step and a normalized target rectangle where available; the HTML reporter packages captured frames into a self-contained `report.html`. The markdown reporter writes `report.md` beside the result and links non-pass frames by the same relative `path`. Goal-authoring and self-healing views in the PoC are outside 0.1 scope; the PoC's `DIVERGED` status is not a canonical verdict.

Report output is sensitive. Declared runtime secrets are replaced in text fields; URL credentials, query, and fragment are stripped by default. URL paths and screenshots may still contain private data. `--sensitive-origin=URL` suppresses metadata and capture for that origin; `--no-evidence` disables default non-pass/flagged screenshots. Replay is opt-in. Evidence lives in separate, private files under the run directory, not inline JSON: `evidence/<attempt-key>/<frame>.jpg`, where each attempt directory is created once and never reused, and `path` is relative to the run directory. Redaction cannot guarantee removal of undeclared secrets or text rendered in screenshot pixels; mark sensitive pages or disable evidence. Retain and delete run directories according to your own data policy.
