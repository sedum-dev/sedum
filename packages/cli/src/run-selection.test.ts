import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "./config.js";
import { discoverRunTests, selectRunTests } from "./run-selection.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("run selection", () => {
  it("combines path, label and name filters over stable metadata", () => {
    const tests = [
      {
        id: "checkout",
        idSource: "explicit" as const,
        file: "tests/cart.test.yaml",
        description: "Guest Cart",
        tags: ["smoke", "shop"],
      },
      {
        id: "login",
        idSource: "explicit" as const,
        file: "tests/login.test.yaml",
        description: "User Login",
        tags: ["smoke"],
      },
    ];
    expect(
      selectRunTests(tests, {
        include: ["tests/*.test.yaml"],
        exclude: ["**/login*"],
        labels: ["smoke", "shop"],
        names: ["CART"],
      }).map((test) => test.id),
    ).toEqual(["checkout"]);
    expect(selectRunTests(tests, { labels: ["shop", "auth"] })).toEqual([]);
  });

  it("rejects an explicit symlink before reading its outside target while still selecting valid files", async () => {
    root = await mkdtemp(path.join(tmpdir(), "sedum-run-select-"));
    const outside = await mkdtemp(path.join(tmpdir(), "sedum-run-outside-"));
    try {
      await mkdir(path.join(root, "tests"));
      await writeFile(path.join(root, "sedum.config.yaml"), "{}\n");
      await writeFile(
        path.join(root, "tests", "good.test.yaml"),
        "id: good\nurl: https://example.test\nsteps: [verify page]\n",
      );
      await writeFile(
        path.join(outside, "secret.test.yaml"),
        "id: secret\nsteps: [verify secret]\n",
      );
      await symlink(
        path.join(outside, "secret.test.yaml"),
        path.join(root, "tests", "external.test.yaml"),
      );
      const config = await loadProjectConfig(root, {});
      const selected = await discoverRunTests(config, [
        "tests/external.test.yaml",
        "tests/good.test.yaml",
      ]);
      expect(selected.tests.map((test) => test.id)).toEqual(["good"]);
      expect(selected.problems).toEqual([
        expect.objectContaining({
          file: "tests/external.test.yaml",
          code: "symlinked_path",
        }),
      ]);
      expect(JSON.stringify(selected)).not.toContain("secret");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports a named path outside the project without exposing it in the result", async () => {
    root = await mkdtemp(path.join(tmpdir(), "sedum-run-select-"));
    await writeFile(path.join(root, "sedum.config.yaml"), "{}\n");
    const config = await loadProjectConfig(root, {});
    const selected = await discoverRunTests(config, ["../private.test.yaml"]);
    expect(selected.problems).toEqual([
      expect.objectContaining({
        file: "<outside-project>",
        code: "outside_root",
      }),
    ]);
    expect(JSON.stringify(selected)).not.toContain("private.test.yaml");
  });
});
