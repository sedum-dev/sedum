import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeInitCommand } from "./init-command.js";
import { runCli } from "./run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-init-"));
  roots.push(root);
  return root;
}

describe("sedum init", () => {
  it("creates a runnable example and prints a precise missing-prerequisite path", async () => {
    const cwd = await project();
    const result = await executeInitCommand({
      cwd,
      interactive: false,
      color: false,
      browser: () => false,
      nodeVersion: "20.18.0",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Install Node 20.19.0 or newer");
    expect(result.stdout).toContain("sedum browsers install chromium");
    expect(result.stdout).toContain("TYPESAFE_API_KEY");
    expect(result.stdout).toContain("sedum run tests/example.test.yaml");
    expect(result.stdout).not.toContain("\u001b[");
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe(
      ".env\n.sedum/runs/\n.sedum/reports/\n",
    );
    expect(await readFile(path.join(cwd, ".env.example"), "utf8")).toContain(
      "SAUCE_PASSWORD=secret_sauce",
    );
    const validation = await runCli(["validate"], "0.0.0", { cwd });
    expect(validation.exitCode).toBe(0);
    expect(validation.stdout).toContain(
      "Checked 1 test and 0 modules: all valid.",
    );
  });

  it("keeps existing files and reports missing ignore rules without a prompt", async () => {
    const cwd = await project();
    await writeFile(path.join(cwd, "sedum.config.yaml"), "browser: chrome\n");
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n.env\n");
    const first = await runCli(["init"], "0.0.0", { cwd });
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("kept sedum.config.yaml");
    expect(first.stdout).toContain("add these lines manually");
    expect(await readFile(path.join(cwd, "sedum.config.yaml"), "utf8")).toBe(
      "browser: chrome\n",
    );
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.env\n",
    );
    const second = await runCli(["init"], "0.0.0", { cwd });
    expect(second.stdout).toContain("kept tests/example.test.yaml");
    expect(second.stdout).not.toContain("created");
  });

  it("keeps an existing env template and explains the generated demo credential", async () => {
    vi.stubEnv("SAUCE_PASSWORD", "");
    const cwd = await project();
    await writeFile(path.join(cwd, ".env.example"), "CUSTOM_SETTING=1\n");
    const result = await runCli(["init"], "0.0.0", { cwd });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("kept .env.example");
    expect(result.stdout).toContain("set SAUCE_PASSWORD=secret_sauce");
    expect(await readFile(path.join(cwd, ".env.example"), "utf8")).toBe(
      "CUSTOM_SETTING=1\n",
    );
  });

  it("asks only before appending to an existing ignore file", async () => {
    const cwd = await project();
    await writeFile(path.join(cwd, ".gitignore"), "node_modules/");
    const confirm = vi.fn(async () => true);
    const result = await executeInitCommand({
      cwd,
      interactive: true,
      color: true,
      confirm,
    });
    expect(result.exitCode).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.stdout).toContain("\u001b[32m ████ █████ ████");
    expect(result.stdout).toContain("\u001b[90m░");
    const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
    const artwork = result.stdout
      .replace(ansiColor, "")
      .split("\n")
      .slice(0, 7);
    expect(artwork.map((line) => line.length)).toEqual([
      51, 52, 53, 53, 53, 52, 51,
    ]);
    expect(artwork[0]?.endsWith("████  █████ █   █")).toBe(true);
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.env\n.sedum/runs/\n.sedum/reports/\n",
    );
    const again = await executeInitCommand({
      cwd,
      interactive: true,
      color: false,
      confirm,
    });
    expect(again.exitCode).toBe(0);
    expect(again.stdout).not.toContain("\u001b[");
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("uses a compact banner in narrow terminals", async () => {
    const result = await executeInitCommand({
      cwd: await project(),
      interactive: true,
      color: true,
      columns: 53,
    });
    expect(result.stdout).toContain("\u001b[32m\u001b[1msedum");
    expect(result.stdout).not.toContain("████ █████ ████");
  });

  it("rejects a symlinked tests directory without following it", async () => {
    const cwd = await project();
    const outside = await project();
    await symlink(outside, path.join(cwd, "tests"));
    const result = await executeInitCommand({
      cwd,
      interactive: false,
      color: false,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain(
      "tests exists but is not a regular directory",
    );
    expect(
      await readFile(path.join(outside, "example.test.yaml"), "utf8").catch(
        () => null,
      ),
    ).toBeNull();
  });
});
