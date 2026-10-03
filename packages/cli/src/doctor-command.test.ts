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
    providerName: "typesafe",
    apiKey: "SECRET-KEY",
    cloudflareAccountId: undefined,
    providerBaseUrl: "https://api.typesafe.ai",
    providerModel: "jev-latest",
    vision: {
      enabled: false,
      model: "google/gemini-3.8-flash",
      timeoutMs: 10_000,
    },
    visionApiKey: undefined,
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

  it("checks the vision key only when vision is enabled or requested", async () => {
    const config = await fixture();
    const visionAuth = vi.fn(async (key: string) =>
      key === "sk-or-good" ? ("accepted" as const) : ("rejected" as const),
    );
    const ids = (result: Awaited<ReturnType<typeof executeDoctorCommand>>) =>
      result.checks.map((check) => check.id);
    const off = await executeDoctorCommand(config.projectRoot, {
      ...probes(config),
      visionAuth,
    });
    expect(ids(off)).not.toContain("vision_auth");
    expect(visionAuth).not.toHaveBeenCalled();

    const enabled = {
      ...config,
      vision: { ...config.vision, enabled: true },
      visionApiKey: "sk-or-bogus",
    };
    const rejected = await executeDoctorCommand(config.projectRoot, {
      ...probes(enabled),
      visionAuth,
    });
    expect(
      rejected.checks.filter((check) => check.id.startsWith("vision")),
    ).toEqual([
      expect.objectContaining({ id: "vision_key", status: "pass" }),
      expect.objectContaining({
        id: "vision_auth",
        status: "fail",
        message: "OpenRouter rejected OPEN_ROUTER_API_KEY.",
      }),
    ]);
    expect(JSON.stringify(rejected)).not.toContain("sk-or-bogus");

    const requested = await executeDoctorCommand(
      config.projectRoot,
      { ...probes({ ...config, visionApiKey: "sk-or-good" }), visionAuth },
      { vision: true },
    );
    expect(
      requested.checks.find((check) => check.id === "vision_auth")?.status,
    ).toBe("pass");

    const missing = await executeDoctorCommand(
      config.projectRoot,
      { ...probes(config), visionAuth },
      { vision: true },
    );
    expect(
      missing.checks.find((check) => check.id === "vision_key"),
    ).toMatchObject({ status: "fail" });
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

  it("uses Cloudflare's fixed route and validates one billed Clef inference", async () => {
    const base = await fixture();
    const config = {
      ...base,
      providerName: "clef" as const,
      providerModel: "clef-flash",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      apiKey: "cloudflare-token",
      providerBaseUrl: "https://attacker.invalid/ignored",
    };
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run/@cf/cloudflare/clef-flash",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer cloudflare-token",
        );
        expect(init?.redirect).toBe("error");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("clef-flash");
        expect(Object.keys(body.questions)).toEqual(["holds", "contradicted"]);
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: {
            model: "clef-flash",
            answers: {
              holds: { type: "noul", noul: 0.91 },
              contradicted: { type: "noul", noul: 0.07 },
            },
            usage: { input_tokens: 10, output_tokens: 2 },
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const network = vi.fn(async () => true);
    const result = await executeDoctorCommand(config.projectRoot, {
      nodeVersion: "20.19.0",
      loadConfig: async () => config,
      browser: () => true,
      network,
      output: async () => undefined,
    });
    expect(network).toHaveBeenCalledWith("https://api.cloudflare.com");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      result.checks.find((check) => check.id === "api_auth"),
    ).toMatchObject({
      status: "pass",
      message: "Cloudflare completed the explicitly billable inference probe.",
    });
    expect(JSON.stringify(result)).not.toContain("cloudflare-token");
  });

  it.each([
    [undefined, "cloudflare-token"],
    ["0123456789abcdef0123456789abcdef", undefined],
  ])(
    "does not probe Clef without both account and token",
    async (accountId, token) => {
      const base = await fixture();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const result = await executeDoctorCommand(base.projectRoot, {
        nodeVersion: "20.19.0",
        loadConfig: async () => ({
          ...base,
          providerName: "clef",
          providerModel: "clef",
          cloudflareAccountId: accountId,
          apiKey: token,
        }),
        browser: () => true,
        network: async () => true,
        output: async () => undefined,
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        result.checks.find((check) => check.id === "api_key")?.status,
      ).toBe("fail");
    },
  );

  it("gives provider-specific missing and rejected Clef credential guidance without leaking the token", async () => {
    const base = await fixture();
    const clef = {
      ...base,
      providerName: "clef" as const,
      providerModel: "clef",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      apiKey: "doctor-sentinel-secret",
    };
    const rejected = await executeDoctorCommand(clef.projectRoot, {
      ...probes(clef),
      auth: async () => "rejected",
    });
    const auth = rejected.checks.find((check) => check.id === "api_auth");
    expect(auth).toMatchObject({
      status: "fail",
      message: "Cloudflare rejected the configured API token.",
      fix: expect.stringContaining("Workers AI Read and Edit"),
    });
    expect(auth?.fix).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(auth?.fix).toContain("CLOUDFLARE_API_TOKEN");
    expect(JSON.stringify(rejected)).not.toContain("doctor-sentinel-secret");
    expect(JSON.stringify(rejected)).not.toContain("TYPESAFE_API_KEY");

    const missing = await executeDoctorCommand(base.projectRoot, {
      ...probes({ ...clef, apiKey: undefined }),
    });
    const serialized = JSON.stringify(missing);
    expect(serialized).toContain("CLOUDFLARE_AUTH_TOKEN");
    expect(serialized).toContain("CLOUDFLARE_API_TOKEN");
    expect(serialized).not.toContain("TYPESAFE_API_KEY");
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
