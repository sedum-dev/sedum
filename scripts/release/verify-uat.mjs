import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assert } from "./packages.mjs";
import { verifyCandidate } from "./verify-candidate.mjs";

const api = "https://api.github.com";
const sourceRepo = "sedum-dev/sedum";
const uatRepo = "sedum-dev/uat";
const candidateRunId = process.env.CANDIDATE_RUN_ID;
const uatRunId = process.env.UAT_RUN_ID;
const sourceToken = process.env.GITHUB_TOKEN;
const uatToken = process.env.UAT_READ_TOKEN;
assert(
  /^\d+$/.test(candidateRunId ?? "") && /^\d+$/.test(uatRunId ?? ""),
  "Candidate and UAT run IDs are required",
);
assert(sourceToken && uatToken, "GitHub and UAT read tokens are required");
assert(
  process.env.GITHUB_REF === "refs/heads/main",
  "Publishing must be dispatched from main",
);

async function github(endpoint, token, binary = false) {
  const response = await fetch(`${api}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  assert(response.ok, `GitHub API ${endpoint} returned ${response.status}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function downloadArtifact(repo, runId, name, token) {
  const list = await github(
    `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
    token,
  );
  const matches = list.artifacts.filter(
    (artifact) => artifact.name === name && !artifact.expired,
  );
  assert(
    matches.length === 1,
    `Expected one unexpired ${name} artifact on ${repo} run ${runId}`,
  );
  const artifact = matches[0];
  assert(
    /^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? ""),
    "Artifact digest is missing",
  );
  const zip = await github(
    `/repos/${repo}/actions/artifacts/${artifact.id}/zip`,
    token,
    true,
  );
  const { createHash } = await import("node:crypto");
  assert(
    `sha256:${createHash("sha256").update(zip).digest("hex")}` ===
      artifact.digest,
    `${name} artifact digest mismatch`,
  );
  const directory = await mkdtemp(path.join(tmpdir(), "sedum-release-"));
  const zipPath = path.join(directory, "artifact.zip");
  await writeFile(zipPath, zip);
  execFileSync("unzip", ["-q", zipPath, "-d", path.join(directory, "files")]);
  return { artifact, directory: path.join(directory, "files") };
}

const candidateRun = await github(
  `/repos/${sourceRepo}/actions/runs/${candidateRunId}`,
  sourceToken,
);
assert(
  candidateRun.conclusion === "success" &&
    candidateRun.event === "workflow_run" &&
    candidateRun.path === ".github/workflows/release-candidate.yml" &&
    candidateRun.head_branch === "main",
  "Candidate run is not a successful main-branch release build",
);
const candidateArtifact = await downloadArtifact(
  sourceRepo,
  candidateRunId,
  "npm-candidate",
  sourceToken,
);
const { manifest, manifestSha256 } = await verifyCandidate(
  candidateArtifact.directory,
);
assert(
  manifest.buildRunId === candidateRunId,
  "Candidate manifest names another build run",
);
assert(
  candidateRun.head_sha === manifest.sourceCommit,
  "Candidate run and manifest commit differ",
);
const main = await github(`/repos/${sourceRepo}/branches/main`, sourceToken);
assert(
  main.commit.sha === manifest.sourceCommit && main.protected === true,
  "Candidate source is no longer the protected main head",
);

const uatRun = await github(
  `/repos/${uatRepo}/actions/runs/${uatRunId}`,
  uatToken,
);
assert(
  uatRun.conclusion === "success" && uatRun.status === "completed",
  "UAT run did not succeed",
);
assert(
  uatRun.path === ".github/workflows/uat.yml" && uatRun.head_branch === "main",
  "UAT run is not from the trusted main workflow",
);
const uatMain = await github(`/repos/${uatRepo}/branches/main`, uatToken);
assert(
  uatMain.protected === true && uatMain.commit.sha === uatRun.head_sha,
  "UAT suite commit is not the current protected main head",
);
const uatArtifact = await downloadArtifact(
  uatRepo,
  uatRunId,
  "uat-result",
  uatToken,
);
const result = JSON.parse(
  await readFile(path.join(uatArtifact.directory, "uat-result.json"), "utf8"),
);
assert(
  result.schemaVersion === 1 && result.status === "passed",
  "UAT result is not a schema v1 pass",
);
assert(
  result.manifestSha256 === manifestSha256 &&
    result.sourceCommit === manifest.sourceCommit,
  "UAT result belongs to another candidate",
);
assert(
  result.uatSuiteCommit === uatRun.head_sha &&
    String(result.uatRunId) === uatRunId,
  "UAT result belongs to another suite or run",
);
assert(
  Date.parse(result.startedAt) >= Date.parse(manifest.createdAt) &&
    Date.parse(result.finishedAt) >= Date.parse(result.startedAt),
  "UAT timestamps are invalid",
);
assert(
  Array.isArray(result.checks) &&
    result.checks.length >= 2 &&
    result.checks.every(
      (check) =>
        check.status === "passed" &&
        Number.isInteger(check.actualExitCode) &&
        check.actualExitCode === check.expectedExitCode,
    ),
  "UAT checks are missing or failed",
);
assert(
  result.checks.some((check) => check.name === "packaged-cli"),
  "Packaged CLI check is missing",
);
assert(
  result.checks.some(
    (check) =>
      check.name === "live-typesafe" &&
      Number.isInteger(check.providerCalls) &&
      check.providerCalls > 0,
  ),
  "Live TypeSafe check is missing",
);

const environment = await github(
  `/repos/${sourceRepo}/environments/npm-release`,
  sourceToken,
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
  `/repos/${sourceRepo}/environments/npm-release/deployment-branch-policies`,
  sourceToken,
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
    candidateArtifactId: candidateArtifact.artifact.id,
    candidateArtifactDigest: candidateArtifact.artifact.digest,
    uatRunId,
    uatSuiteCommit: uatRun.head_sha,
  }),
);
