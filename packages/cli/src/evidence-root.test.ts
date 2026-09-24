import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { junitEvidenceDirectory } from "./evidence-root.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function checkout() {
  root = await mkdtemp(path.join(tmpdir(), "sedum-evidence-root-"));
  const project = path.join(root, "apps", "web");
  const run = path.join(project, ".sedum", "runs", "run-1");
  await mkdir(run, { recursive: true });
  return { root, project, run };
}

describe("JUnit evidence directory", () => {
  it("is relative to the project root outside CI", async () => {
    const { project, run } = await checkout();
    expect(await junitEvidenceDirectory(run, project, {})).toBe(
      ".sedum/runs/run-1",
    );
  });

  it.each(["CI_PROJECT_DIR", "WORKSPACE", "GITHUB_WORKSPACE"])(
    "is relative to %s when the project sits below the checkout",
    async (name) => {
      const { root: base, project, run } = await checkout();
      expect(await junitEvidenceDirectory(run, project, { [name]: base })).toBe(
        "apps/web/.sedum/runs/run-1",
      );
    },
  );

  it("takes the first CI root that contains the run, in a fixed order", async () => {
    const { root: base, project, run } = await checkout();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "sedum-elsewhere-"));
    try {
      expect(
        await junitEvidenceDirectory(run, project, {
          CI_PROJECT_DIR: elsewhere,
          WORKSPACE: path.join(base, "apps"),
          GITHUB_WORKSPACE: base,
        }),
      ).toBe("web/.sedum/runs/run-1");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("ignores relative, missing, sibling-prefix and non-containing roots", async () => {
    const { root: base, project, run } = await checkout();
    await mkdir(path.join(base, "apps", "web2"));
    for (const value of [
      "apps",
      path.join(base, "missing"),
      path.join(base, "apps", "we"),
      path.join(base, "apps", "web2"),
      run,
    ])
      expect(
        await junitEvidenceDirectory(run, project, { CI_PROJECT_DIR: value }),
        value,
      ).toBe(".sedum/runs/run-1");
  });

  it("follows symlinked roots to the real directories", async () => {
    const { root: base, project, run } = await checkout();
    const link = path.join(base, "link");
    await symlink(base, link);
    expect(
      await junitEvidenceDirectory(
        path.join(link, "apps", "web", ".sedum", "runs", "run-1"),
        project,
        { WORKSPACE: link },
      ),
    ).toBe("apps/web/.sedum/runs/run-1");
    expect(await junitEvidenceDirectory(run, project, {})).toBe(
      ".sedum/runs/run-1",
    );
  });

  it("lists no attachments when no usable relative path exists", async () => {
    const { root: base, project } = await checkout();
    const bracketed = path.join(project, ".sedum", "runs", "[run]");
    await mkdir(bracketed);
    expect(await junitEvidenceDirectory(bracketed, project, {})).toBeNull();
    expect(
      await junitEvidenceDirectory(path.join(base, "gone"), project, {}),
    ).toBeNull();
    const outside = await mkdtemp(path.join(tmpdir(), "sedum-outside-"));
    try {
      expect(await junitEvidenceDirectory(outside, project, {})).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
