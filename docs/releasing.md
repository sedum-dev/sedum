# Releasing Sedum

The four npm packages share one version: `sedum-cli`, `@sedum-dev/core`, `@sedum-dev/provider-typesafe`, and `@sedum-dev/reporters`. Changesets is in `alpha` prerelease mode. The first version PR should therefore be `0.1.0-alpha.0`; public npm releases use the `next` tag.

## Flow

1. A change PR includes a changeset. CI builds, packs, hashes, and installs all four tarballs in a clean directory as a dry run.
2. On `main`, `release-pr.yml` opens or updates the Changesets version PR. Review and merge it after CI passes.
3. After CI succeeds on that merge, `release-candidate.yml` builds and packs the versioned packages from the merged SHA. It rebuilds on later `main` commits while that version remains unpublished, so a newer source commit supersedes the old candidate. Its `npm-candidate` artifact contains `manifest.json` and all four tarballs. The candidate workflow installs that exact tarball set on Linux, macOS, and Windows. Retention is 60 days. Record the candidate workflow run ID, artifact ID/digest, and manifest SHA-256.
4. For the temporary alpha path, a maintainer dispatches `publish-npm.yml` on `main` with the successful candidate run ID. It checks the run, artifact digest, manifest, package hashes, current `main` commit, alpha version, and protected release environment. It has no UAT input.
5. The `npm-release` environment requires a fresh human approval. The publish job repeats the candidate checks after approval, publishes the exact tarballs with provenance under `next`, checks registry bytes and integrity, creates a GitHub release from the Changesets changelogs, and tests a clean public install on Linux, macOS, and Windows.

Any new source commit after candidate validation requires another candidate. Failed, missing, expired, or unverifiable artifacts block publication. npm versions are immutable. A rerun after partial publication skips only packages whose public tarball bytes match the candidate; a mismatch blocks the release.

This alpha path temporarily omits the independent UAT requirement in SED-84. The `sedum-dev/uat` runner and factory dispatch/result gate remain planned in SED-85 through SED-89. Before enabling that gate, replace `verify-alpha-candidate.mjs` with a verifier that also checks the protected UAT workflow run, suite commit, result artifact, and candidate manifest hash; remove the alpha-only exception. The candidate artifact format remains compatible with that work. The current `sedum-dev/sedum` `main` branch is not protected, so this alpha path relies on the current `main` commit check and the separate `npm-release` approval. Protect `main` as part of the factory/merge-approval work.

## Required repository and npm setup

- The `npm-release` environment is configured with `devnacho` as required reviewer, administrator bypass disabled, and deployment restricted to `main`. The guard checks those branch and reviewer rules before publication.
- Add `RELEASE_PR_TOKEN` as a fine-grained GitHub token with repository Contents and Pull requests write access. The organization currently disallows PR creation using the built-in `GITHUB_TOKEN`, so `release-pr.yml` uses this token to open the Changesets version PR and trigger its normal PR checks.
- The source repository `GITHUB_TOKEN` reads its candidate workflow run and artifact. `UAT_READ_TOKEN` will be needed when the separate UAT gate is implemented.
- For subsequent publishes, configure npm trusted publishing separately on each package for repository `sedum-dev/sedum`, workflow `publish-npm.yml`, environment `npm-release`, and allow direct `npm publish`. GitHub's publish job has `id-token: write` and uses Node 24/npm 11. Trusted publishing generates provenance for public packages from this public repository.
- An unclaimed package cannot have a trusted publisher configured through its package settings. For the first publish, place a short-lived npm automation token in `BOOTSTRAP_NPM_TOKEN` and remove it after claiming all four names; the workflow still uses `--provenance`. Configure trusted publishers and revoke the bootstrap token before the next release.

The release workflow does not publish on merge. During this temporary alpha phase, publishing requires a successful three-platform candidate install and the later environment approval. SED-89 owns the future independent UAT gate, factory handoff, failure routing, and journal entries.
