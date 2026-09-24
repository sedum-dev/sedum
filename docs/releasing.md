# Releasing Sedum

The four npm packages share one version: `sedum-cli`, `@sedum-dev/core`, `@sedum-dev/provider-typesafe`, and `@sedum-dev/reporters`. Changesets is in `alpha` prerelease mode. The first version PR should therefore be `0.1.0-alpha.0`; public npm releases use the `next` tag.

## Flow

1. A change PR includes a changeset. CI builds, packs, hashes, and installs all four tarballs in a clean directory as a dry run.
2. On `main`, `release-pr.yml` opens or updates the Changesets version PR. Review and merge it after CI passes.
3. After CI succeeds on that merge, `release-candidate.yml` builds and packs the versioned packages from the merged SHA. It rebuilds on later `main` commits while that version remains unpublished, so a newer source commit supersedes the old candidate. Its `npm-candidate` artifact contains `manifest.json` and all four tarballs. Retention is 60 days. Record the candidate workflow run ID, artifact ID/digest, and manifest SHA-256 in the factory journal.
4. The separate `sedum-dev/uat` workflow installs these exact tarballs and uploads `uat-result.json` as an artifact named `uat-result`. Its result must follow SED-84 schema version 1 and name the candidate manifest hash, source commit, UAT suite commit, and UAT run ID. The UAT suite must produce passing `packaged-cli` and `live-typesafe` checks; the latter must report at least one provider call.
5. A maintainer dispatches `publish-npm.yml` with the candidate and UAT run IDs. The workflow downloads both artifacts, checks the GitHub artifact digests and package hashes, verifies the UAT run and result against the protected UAT `main`, and requires the candidate to remain the protected source `main` head. The `npm-release` environment then requires a separate human approval. The publish job repeats the checks after approval, publishes the exact tarballs with provenance under `next`, checks registry bytes and integrity, creates a GitHub release from the Changesets changelogs, and tests a clean public install on Linux, macOS, and Windows.

Any new source commit or UAT suite commit after candidate validation requires another candidate or UAT run respectively. Failed, missing, expired, or unverifiable artifacts block publication. npm versions are immutable. A rerun after partial publication skips only packages whose public tarball bytes match the candidate; a mismatch blocks the release.

## Required repository and npm setup

- Protect `main` in `sedum-dev/sedum` and the separate `sedum-dev/uat` repository. The publish guard checks both branches. The UAT workflow file must be `.github/workflows/uat.yml` on protected `main` and upload `uat-result` with GitHub Actions artifact v4.
- The `npm-release` environment is configured with `devnacho` as required reviewer, administrator bypass disabled, and deployment restricted to `main`. The guard checks those branch and reviewer rules before publication.
- Add `RELEASE_PR_TOKEN` as a fine-grained GitHub token with repository Contents and Pull requests write access. The organization currently disallows PR creation using the built-in `GITHUB_TOKEN`, so `release-pr.yml` uses this token to open the Changesets version PR and trigger its normal PR checks.
- Add a read-only `UAT_READ_TOKEN` repository secret with access to the private `sedum-dev/uat` workflow runs and artifacts. The source repository `GITHUB_TOKEN` reads its own candidate run.
- For subsequent publishes, configure npm trusted publishing separately on each package for repository `sedum-dev/sedum`, workflow `publish-npm.yml`, environment `npm-release`, and allow direct `npm publish`. GitHub's publish job has `id-token: write` and uses Node 24/npm 11. Trusted publishing generates provenance for public packages from this public repository.
- An unclaimed package cannot have a trusted publisher configured through its package settings. For the first publish, place a short-lived npm automation token in `BOOTSTRAP_NPM_TOKEN` and remove it after claiming all four names; the workflow still uses `--provenance`. Configure trusted publishers and revoke the bootstrap token before the next release.

The release workflow does not publish on merge. Publishing requires the independent UAT result and the later environment approval. SED-89 owns the factory handoff, failure routing, and journal entries; the checks here are the CI enforcement boundary.
