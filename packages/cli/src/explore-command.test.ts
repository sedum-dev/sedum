import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { exploreDetect, exploreSafe } from "./cli-arguments.js";
import {
  exploreMode,
  exploreProvider,
  seedValue,
  startUrl,
  watchOrigin,
} from "./explore-command.js";
import { runCli } from "./run-cli.js";

describe("explore arguments", () => {
  it("accepts seeds, modes and absolute web URLs", () => {
    expect(seedValue("0")).toBe(0);
    expect(seedValue("2147483647")).toBe(2147483647);
    expect(exploreMode("random")).toBe("random");
    expect(startUrl("https://example.test/a")).toBe("https://example.test/a");
  });

  it("collects watched origins", () => {
    expect(watchOrigin("https://api.example.test/v1")).toEqual([
      "https://api.example.test",
    ]);
    expect(watchOrigin("https://b.test", ["https://a.test"])).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("rejects malformed values", () => {
    for (const bad of ["-1", "1.5", "2147483648", "x", ""])
      expect(() => seedValue(bad)).toThrow(InvalidArgumentError);
    expect(() => exploreMode("smart")).toThrow(InvalidArgumentError);
    expect(exploreDetect("semantic")).toBe("semantic");
    expect(() => exploreDetect("off")).toThrow(/browser or semantic/u);
    expect(() => startUrl("file:///etc/passwd")).toThrow(InvalidArgumentError);
    expect(() => startUrl("/relative")).toThrow(InvalidArgumentError);
  });

  it("needs a start URL unless it replays a trace", async () => {
    const output = await runCli(["explore", "--mode", "random"], "0.0.0");
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("Missing start URL");
  });

  it("asks for guided mode with --detect semantic", async () => {
    const output = await runCli(
      [
        "explore",
        "https://example.test/",
        "--mode",
        "random",
        "--detect",
        "semantic",
      ],
      "0.0.0",
    );
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("--mode guided");
  });

  it("takes --planner effects only with guided mode", async () => {
    const output = await runCli(
      [
        "explore",
        "https://example.test/",
        "--mode",
        "heuristic",
        "--planner",
        "effects",
      ],
      "0.0.0",
    );
    expect(output.exitCode).toBe(3);
    expect(output.stderr).toContain("--planner effects");
    const bad = await runCli(
      ["explore", "https://example.test/", "--planner", "smart"],
      "0.0.0",
    );
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("walk, effects");
  });

  it("rejects malformed --detect-allow rules", async () => {
    const output = await runCli(
      [
        "explore",
        "https://example.test/",
        "--detect-allow",
        "console_error:re:(",
      ],
      "0.0.0",
    );
    expect(output.exitCode).not.toBe(0);
  });

  it("takes --safe and --safe strict, and has no --allow-destructive", async () => {
    expect(exploreSafe("strict")).toBe("strict");
    expect(() => exploreSafe("maybe")).toThrow(/--safe strict/u);
    const removed = await runCli(
      ["explore", "https://example.test/", "--allow-destructive"],
      "0.0.0",
    );
    expect(removed.exitCode).not.toBe(0);
    expect(removed.stderr).toContain("unknown option");
  });

  it("reruns only an exploration trace", async () => {
    const output = await runCli(
      ["explore", "--rerun", "package.json"],
      "0.0.0",
    );
    expect(output.exitCode).not.toBe(0);
  });
});

describe("explore provider settings", () => {
  async function project(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "sedum-explore-env-"));
    for (const [name, contents] of Object.entries(files))
      await writeFile(path.join(root, name), contents);
    return root;
  }

  it("reads TYPESAFE_* from the project-root .env, under the shell's values", async () => {
    const root = await project({
      "sedum.config.yaml": "browser: chromium\n",
      ".env": "TYPESAFE_API_KEY=file-key\nTYPESAFE_DEFAULT_MODEL=file-model\n",
    });
    try {
      const nested = path.join(root, "pages");
      await mkdir(nested);
      expect(await exploreProvider(nested, {})).toEqual({
        provider: { apiKey: "file-key", model: "file-model" },
        keyName: "TYPESAFE_API_KEY",
      });
      expect(
        (await exploreProvider(nested, { TYPESAFE_API_KEY: "shell-key" }))
          .provider.apiKey,
      ).toBe("shell-key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads the key from provider.apiKeyEnv, without falling back to TYPESAFE_API_KEY", async () => {
    const root = await project({
      "sedum.config.yaml": "provider:\n  apiKeyEnv: E2E_TYPESAFE_KEY\n",
      ".env": "E2E_TYPESAFE_KEY=custom-key\nTYPESAFE_API_KEY=default-key\n",
    });
    try {
      expect(await exploreProvider(root, {})).toEqual({
        provider: { apiKey: "custom-key" },
        keyName: "E2E_TYPESAFE_KEY",
      });
      await writeFile(path.join(root, ".env"), "");
      expect(
        await exploreProvider(root, { TYPESAFE_API_KEY: "default-key" }),
      ).toEqual({ provider: { apiKey: "" }, keyName: "E2E_TYPESAFE_KEY" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the default environment's key name, as sedum run does without --env", async () => {
    const root = await project({
      "sedum.config.yaml":
        "environment: staging\nprovider:\n  apiKeyEnv: LOCAL_KEY\nenvironments:\n  staging:\n    provider:\n      apiKeyEnv: STAGING_KEY\n",
      ".env": "LOCAL_KEY=local-key\nSTAGING_KEY=staging-key\n",
    });
    try {
      expect(await exploreProvider(root, {})).toEqual({
        provider: { apiKey: "staging-key" },
        keyName: "STAGING_KEY",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
