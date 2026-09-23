import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  lstat,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResolvedProjectConfig } from "./config.js";
import { loadProjectConfig } from "./config.js";
import {
  checkOutputWritable,
  executeDoctorCommand,
  type DoctorProbes,
} from "./doctor-command.js";
import { runCli } from "./run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<ResolvedProjectConfig> {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-doctor-"));
  roots.push(root);
  return {
    projectRoot: root,
    configPath: null,
    environment: null,
    testDirectory: path.join(root, "tests"),
    include: ["**/*.test.yaml"],
    exclude: [],
    browser: "chrome",
    viewport: { width: 1280, height: 900 },
    thresholds: { minP: 0.75, band: 0.15, contradictionCutoff: 0.5 },
    outputDir: path.join(root, ".sedum", "runs"),
    reporterDir: path.join(root, ".sedum", "reports"),
    baseUrl: null,
    variables: {},
    apiKey: "SECRET-KEY",
  };
}

function probes(config: ResolvedProjectConfig): DoctorProbes {
  return {
    nodeVersion: "20.19.0",
    loadConfig: async () => config,
    browser: () => true,
    network: async () => true,
    auth: async () => "accepted",
    output: async () => undefined,
  };
}

describe("sedum doctor", () => {
  it("emits seven passing checks and parseable JSON", async () => {
    const config = await fixture();
    const result = await runCli(["doctor", "--json"], "0.0.0", {
      cwd: config.projectRoot,
      doctorProbes: probes(config),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const json = JSON.parse(result.stdout);
    expect(json.schemaVersion).toBe(1);
    expect(json.checks.map((item: { id: string }) => item.id)).toEqual([
      "node",
      "config",
      "browser",
      "api_network",
      "api_key",
      "api_auth",
      "output",
    ]);
    expect(
      json.checks.every(
        (item: { status: string; fix: string | null }) =>
          item.status === "pass" && item.fix === null,
      ),
    ).toBe(true);
    expect(result.stdout).not.toContain("SECRET-KEY");
  });

  it.each([
    ["node", { nodeVersion: "20.18.9" }],
    ["browser", { browser: () => false }],
    ["api_network", { network: async () => false }],
    [
      "api_key",
      {
        loadConfig: async (cwd: string) => ({
          ...(await fixture()),
          projectRoot: cwd,
          apiKey: undefined,
        }),
      },
    ],
    ["api_auth", { auth: async () => "rejected" as const }],
    [
      "output",
      {
        output: async () => {
          throw new Error("denied");
        },
      },
    ],
  ] as const)("reports a failing %s check with a fix", async (id, override) => {
    const config = await fixture();
    const result = await executeDoctorCommand(config.projectRoot, {
      ...probes(config),
      ...override,
    });
    const check = result.checks.find((item) => item.id === id);
    expect(check?.status).toBe("fail");
    expect(check?.fix).toBeTruthy();
  });

  it("does not claim dependent checks pass when config fails", async () => {
    const config = await fixture();
    let browserCalls = 0;
    let authCalls = 0;
    let outputCalls = 0;
    const result = await executeDoctorCommand(config.projectRoot, {
      ...probes(config),
      loadConfig: async () => {
        throw new Error("malformed YAML with SECRET-KEY");
      },
      browser: () => {
        browserCalls++;
        return true;
      },
      auth: async () => {
        authCalls++;
        return "accepted";
      },
      output: async () => {
        outputCalls++;
      },
    });
    expect(
      result.checks
        .filter((item) => item.status === "fail")
        .map((item) => item.id),
    ).toEqual(["config", "browser", "api_key", "api_auth", "output"]);
    expect(
      result.checks.find((item) => item.id === "api_network")?.status,
    ).toBe("pass");
    expect([browserCalls, authCalls, outputCalls]).toEqual([0, 0, 0]);
    expect(JSON.stringify(result)).not.toContain("SECRET-KEY");
  });

  it("handles a malformed project config using the real loader", async () => {
    const config = await fixture();
    await writeFile(
      path.join(config.projectRoot, "sedum.config.yaml"),
      "browser: [broken\n",
    );
    const result = await executeDoctorCommand(config.projectRoot, {
      ...probes(config),
      loadConfig: (cwd) => loadProjectConfig(cwd, {}),
    });
    expect(result.checks.find((item) => item.id === "config")?.status).toBe(
      "fail",
    );
    expect(result.checks.find((item) => item.id === "output")?.status).toBe(
      "fail",
    );
  });

  it("classifies a timed-out network request without exposing its error", async () => {
    const config = await fixture();
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout SECRET-KEY");
    });
    const result = await executeDoctorCommand(config.projectRoot, {
      nodeVersion: "20.19.0",
      loadConfig: async () => config,
      browser: () => true,
      auth: async () => "accepted",
      output: async () => undefined,
    });
    expect(
      result.checks.find((item) => item.id === "api_network")?.status,
    ).toBe("fail");
    expect(JSON.stringify(result)).not.toContain("SECRET-KEY");
  });

  it("keeps JSON parseable on multiple failures and reports exit 3", async () => {
    const config = await fixture();
    const result = await runCli(["doctor", "--json"], "0.0.0", {
      cwd: config.projectRoot,
      doctorProbes: {
        ...probes(config),
        nodeVersion: "18.0.0",
        network: async () => false,
        auth: async () => {
          throw new Error("must not call");
        },
      },
    });
    expect(result.exitCode).toBe(3);
    const json = JSON.parse(result.stdout);
    expect(
      json.checks.find((item: { id: string }) => item.id === "api_auth").status,
    ).toBe("fail");
    expect(result.stderr).toBe("");
  });

  it("probes actual output writes and removes only its temporary paths", async () => {
    const config = await fixture();
    await checkOutputWritable(config);
    expect(await readdir(config.projectRoot)).toEqual([]);
    const blocked = path.join(config.projectRoot, "blocked");
    await writeFile(blocked, "file");
    await expect(
      checkOutputWritable({ ...config, outputDir: path.join(blocked, "runs") }),
    ).rejects.toThrow();
    const target = path.join(config.projectRoot, "target");
    await writeFile(target, "file");
    const link = path.join(config.projectRoot, "link");
    await symlink(target, link);
    await expect(
      checkOutputWritable({ ...config, outputDir: path.join(link, "runs") }),
    ).rejects.toThrow();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
