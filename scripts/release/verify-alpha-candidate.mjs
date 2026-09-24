import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert } from "./packages.mjs";
import { verifyCandidate } from "./verify-candidate.mjs";

const repository = "sedum-dev/sedum";
const candidateRunId = process.env.CANDIDATE_RUN_ID;
const token = process.env.GITHUB_TOKEN;
assert(/^\d+$/.test(candidateRunId ?? ""), "Candidate run ID is required");
assert(token, "GitHub token is required");
assert(
  process.env.GITHUB_REF === "refs/heads/main",
  "Publishing must be dispatched from main",
);

async function github(endpoint, binary = false) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  assert(response.ok, `GitHub API ${endpoint} returned ${response.status}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

const run = await github(`/repos/${repository}/actions/runs/${candidateRunId}`);
assert(
  run.conclusion === "success" &&
    run.event === "workflow_run" &&
    run.path === ".github/workflows/release-candidate.yml" &&
    run.head_branch === "main",
  "Candidate run is not a successful main-branch release build",
);
const artifacts = await github(
  `/repos/${repository}/actions/runs/${candidateRunId}/artifacts?per_page=100`,
);
const matches = artifacts.artifacts.filter(
  (artifact) => artifact.name === "npm-candidate" && !artifact.expired,
);
assert(matches.length === 1, "Expected one unexpired npm-candidate artifact");
const artifact = matches[0];
assert(
  /^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? ""),
  "Candidate artifact digest is missing",
);
const zip = await github(
  `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
  true,
);
assert(
  `sha256:${createHash("sha256").update(zip).digest("hex")}` ===
    artifact.digest,
  "Candidate artifact digest mismatch",
);
const directory = await mkdtemp(path.join(tmpdir(), "sedum-candidate-"));
const zipPath = path.join(directory, "artifact.zip");
await writeFile(zipPath, zip);
execFileSync("unzip", ["-q", zipPath, "-d", path.join(directory, "files")]);
const { manifest, manifestSha256 } = await verifyCandidate(
  path.join(directory, "files"),
);
assert(
  manifest.buildRunId === candidateRunId,
  "Candidate manifest names another build run",
);
assert(
  run.head_sha === manifest.sourceCommit,
  "Candidate run and manifest commit differ",
);
assert(
  /^\d+\.\d+\.\d+-alpha\.\d+$/.test(manifest.packages[0].version),
  "Temporary publish path accepts alpha versions only",
);
const main = await github(`/repos/${repository}/branches/main`);
assert(
  main.commit.sha === manifest.sourceCommit,
  "A newer main commit superseded this candidate",
);

const environment = await github(
  `/repos/${repository}/environments/npm-release`,
);
assert(
  environment.protection_rules?.some(
    (rule) => rule.type === "required_reviewers" && rule.reviewers?.length > 0,
  ),
  "npm-release must require a human reviewer",
);
assert(
  environment.can_admins_bypass === false,
  "npm-release must disallow approval bypass",
);
assert(
  environment.deployment_branch_policy?.custom_branch_policies === true,
  "npm-release must restrict deployment branches",
);
const policies = await github(
  `/repos/${repository}/environments/npm-release/deployment-branch-policies`,
);
assert(
  policies.total_count === 1 &&
    policies.branch_policies?.[0]?.name === "main" &&
    policies.branch_policies?.[0]?.type === "branch",
  "npm-release must allow only main",
);

console.log(
  JSON.stringify({
    manifestSha256,
    sourceCommit: manifest.sourceCommit,
    version: manifest.packages[0].version,
    candidateArtifactId: artifact.id,
    candidateArtifactDigest: artifact.digest,
  }),
);
