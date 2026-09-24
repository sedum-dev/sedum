# Running in CI

A CI job fails when `sedum run` exits non-zero, on any CI system. Exits are
`0` for a pass (a flagged pass included), `1` for a failed test, `2` for a
flagged pass under `--strict`, and `3` when the run could not produce a
verdict you can trust. The reporters below add detail on top of that gate.

| Reporter   | File                                 | Read by                                                          |
| ---------- | ------------------------------------ | ---------------------------------------------------------------- |
| `markdown` | `<outputDir>/<run-id>/report.md`     | people and coding agents; a GitHub job summary                   |
| `junit`    | `<reporterDir>/<run-id>/junit.xml`   | GitLab, Jenkins, CircleCI, Azure DevOps, JUnit actions on GitHub |
| `json`     | `<reporterDir>/<run-id>/result.json` | your own tooling                                                 |
| (always)   | `<outputDir>/<run-id>/report.html`   | people, offline                                                  |

`--reporter` takes a comma-separated list: `--reporter junit,markdown`. When
no terminal reporter is selected, stdout prints `markdown <path>` and then
`junit <path>`, so a later step can read both paths. Each run gets its own
`<run-id>` directory, so a glob such as `.sedum/reports/*/junit.xml` finds
the file.

## How a run maps to JUnit

Each test file is one `<testsuite>` with one `<testcase>`, named by the test's
description (or its file when there is none). The testcase's `classname` and
the suite's `file` are the test file. A suite named `sedum run` comes first
and carries run totals as properties: tests passed and failed, flagged steps,
and counts for each flag.

| Sedum result                                            | JUnit                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| passed                                                  | passing testcase                                             |
| passed with flags                                       | passing testcase; flags in `sedum.flags` and the output      |
| passed with flags, `--strict`                           | `<failure type="sedum.flagged">`                             |
| failed                                                  | `<failure>` typed by the error code, in both modes           |
| stopped before a verdict (error, interruption, timeout) | `<error>`                                                    |
| run could not produce a verdict (exit 3)                | `<error>` on the `sedum run` testcase                        |
| flagged run under `--strict` (exit 2)                   | `<failure type="sedum.flagged">` on the `sedum run` testcase |
| discovery problem                                       | `<error>` in a `discovery` suite                             |

So the XML never contradicts the exit code, and no testcase carries more
than one status. A failure lists each step that needs attention: its
sentence, `file:line:col`, scores against the decision lines, page, browser
error and call log, judged page text, frame, and a rerun command.

Many JUnit viewers, including GitLab, ignore properties, so a flagged pass
shows as green by default. Read the flag counts from `report.md` or
`result.json`, or run with `--strict` to make flags fail the job.

If writing `junit.xml` fails, the run exits 3 with `reporter_output_error`,
all rendered reports are removed, and `result.json` records the error. If the
reporter directory itself breaks, the error is `output_error` when `json` is
selected; the canonical `result.json` survives either way. When a terminal
reporter fails, `junit.xml` is rewritten to describe the errored run.

### Evidence attachments

A failed or flagged step's frame is attached as
`[[ATTACHMENT|<path>]]` in the testcase output. GitLab shows the first one
per test and the Jenkins JUnit Attachments plugin shows all of them. Upload
the run directory with the XML so the paths resolve.

The path is relative to the CI checkout: Sedum uses the first of
`CI_PROJECT_DIR` (when `GITLAB_CI=true`), `WORKSPACE` (when `JENKINS_URL` is
set) or `GITHUB_WORKSPACE` (when `GITHUB_ACTIONS=true`) that contains the run,
and otherwise the project root. Each variable counts only inside its own CI,
so a stray `WORKSPACE` elsewhere cannot put local directory names in the
report. If the run directory's path contains a character that would break an
attachment line (such as `[`, `|` or a backslash), no frames are attached. In a monorepo with
`sedum.config.yaml` in `apps/web`, paths start with
`apps/web/.sedum/runs/`. Only the path is derived from these variables; their
values are never written to the report. Frames can contain private page
pixels; `--sensitive-origin` and `--no-evidence` omit them.

Text from test files and pages can never form an attachment marker: every
`[[` in it is written as `[ [`.

## GitHub Actions

GitHub renders Markdown job summaries natively, so `report.md` is the
simplest summary. Keep the steps running when the test step fails.

```yaml
- name: Sedum
  run: npx sedum run --reporter list,markdown,junit
  env:
    TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
- name: Job summary
  if: always()
  run: cat .sedum/runs/*/report.md >> "$GITHUB_STEP_SUMMARY"
- name: Upload reports
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: sedum
    path: |
      .sedum/runs/
      .sedum/reports/
```

To show the JUnit file as a test summary instead, add a JUnit action such as
`mikepenz/action-junit-report` with `report_paths: .sedum/reports/*/junit.xml`.
Its `annotate_only: true` mode needs no `checks: write` permission.

## GitLab CI

```yaml
sedum:
  script:
    - npx sedum run --reporter junit
  artifacts:
    when: always
    paths:
      - .sedum/runs/
    reports:
      junit: .sedum/reports/*/junit.xml
```

The merge request test widget shows each test, its failure text and the
first frame. The `paths` entry uploads the frames the attachments name.

## Jenkins

```groovy
sh 'npx sedum run --reporter junit'
junit testResults: '.sedum/reports/*/junit.xml', allowEmptyResults: false
archiveArtifacts artifacts: '.sedum/runs/**', allowEmptyArchive: true
```

A reused workspace keeps earlier runs, and the glob would read them again.
Clean the reporter directory when the job starts, or pass a per-build
directory such as `--reporter-dir .sedum/reports/$BUILD_NUMBER`. Sedum never
deletes files it did not create. In a monorepo, call the `junit` step from
the workspace root with `apps/web/.sedum/reports/*/junit.xml`, not inside
`dir('apps/web')`, because attachment paths are relative to `WORKSPACE`.

A broken `sedum.config.yaml` still exits 3. Its `junit.xml` goes to
`--reporter-dir` or `.sedum/reports`, because a `reporterDir` set in the
broken file cannot be read.
