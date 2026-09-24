---
"@sedum-dev/reporters": minor
"sedum-cli": minor
---

Add `--reporter junit`, which writes `<reporterDir>/<run-id>/junit.xml` for CI test views. A flagged pass stays a passing testcase with its flags as metadata, and `--strict` adds a failure, so the file always matches the exit code. Failures carry the step, source position, scores, browser error and a rerun command. Evidence frames are attached with `[[ATTACHMENT|path]]`, relative to the CI checkout when GitLab, Jenkins or GitHub Actions is running. `--reporter` now also takes a comma-separated list such as `junit,markdown`. `@sedum-dev/reporters` exports `renderJunit`, `isEvidenceDirectory` and `runIsTrustworthy`, which the CLI's exit code now uses.
