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

  const running = {
    GITLAB_CI: "true",
    JENKINS_URL: "https://ci.example.test/",
    GITHUB_ACTIONS: "true",
  };

  it.each([
    ["CI_PROJECT_DIR", "GITLAB_CI", "true"],
    ["WORKSPACE", "JENKINS_URL", "https://ci.example.test/"],
    ["GITHUB_WORKSPACE", "GITHUB_ACTIONS", "true"],
  ])(
    "is relative to %s when the project sits below the checkout",
    async (name, marker, value) => {
      const { root: base, project, run } = await checkout();
      expect(
        await junitEvidenceDirectory(run, project, {
          [name]: base,
          [marker]: value,
        }),
      ).toBe("apps/web/.sedum/runs/run-1");
      // Without its CI running, the same variable is not trusted.
      expect(await junitEvidenceDirectory(run, project, { [name]: base })).toBe(
        ".sedum/runs/run-1",
      );
    },
  );

  it("ignores a broad WORKSPACE outside Jenkins, so home paths never leak", async () => {
    const { root: base, project, run } = await checkout();
    for (const value of ["/", path.dirname(base)])
      expect(
        await junitEvidenceDirectory(run, project, { WORKSPACE: value }),
        value,
      ).toBe(".sedum/runs/run-1");
  });

  it("takes the first CI root that contains the run, in a fixed order", async () => {
    const { root: base, project, run } = await checkout();
    const elsewhere = await mkdtemp(path.join(tmpdir(), "sedum-elsewhere-"));
    try {
      expect(
        await junitEvidenceDirectory(run, project, {
          ...running,
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
        await junitEvidenceDirectory(run, project, {
          GITLAB_CI: "true",
          CI_PROJECT_DIR: value,
        }),
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
        { WORKSPACE: link, JENKINS_URL: "https://ci.example.test/" },
      ),
    ).toBe("apps/web/.sedum/runs/run-1");
    expect(await junitEvidenceDirectory(run, project, {})).toBe(
      ".sedum/runs/run-1",
    );
  });

  it("lists no attachments when no usable relative path exists", async () => {
    const { root: base, project } = await checkout();
    // Every name the renderer would refuse gives no attachments, not a failure.
    // Windows cannot create the pipe and backslash names at all.
    const names =
      process.platform === "win32"
        ? ["[run]"]
        : ["[run]", "a|b", "back\\slash"];
    for (const name of names) {
      const odd = path.join(project, ".sedum", "runs", name);
      await mkdir(odd);
      expect(await junitEvidenceDirectory(odd, project, {}), name).toBeNull();
    }
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
