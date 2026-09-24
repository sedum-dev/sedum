import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverConfiguredTests,
  loadProjectConfig,
  ProjectConfigError,
} from "./config.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project configuration", () => {
  it("uses documented defaults without a config and freezes the result", async () => {
    const root = await temporaryRoot();
    const config = await loadProjectConfig(root, {});
    expect(config).toMatchObject({
      projectRoot: root,
      configPath: null,
      environment: null,
      browser: "chrome",
      viewport: { width: 1280, height: 900 },
      thresholds: { minP: 0.75, band: 0.15, contradictionCutoff: 0.5 },
      baseUrl: null,
      providerBaseUrl: "https://api.typesafe.ai",
      providerModel: "jev-latest",
    });
    expect(config.testDirectory).toBe(path.join(root, "tests"));
    expect(config.outputDir).toBe(path.join(root, ".sedum", "runs"));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.thresholds)).toBe(true);
  });

  it("discovers the nearest ancestor and applies every precedence layer", async () => {
    const root = await temporaryRoot();
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      `tests:
  directory: specs
  include: ["**/*.test.yaml"]
browser: chromium
viewport: { width: 900, height: 700 }
thresholds: { verify: 0.8, lowConfidenceBand: 0.1, contradiction: 0.4 }
outputDir: artifacts/runs
reporterDir: artifacts/reports
baseUrl: https://root.example/app/
environment: staging
variables:
  SHARED: config
  ROOT_ONLY: root
environments:
  staging:
    baseUrl: https://staging.example/app/
    variables:
      SHARED: named
      NAMED_ONLY: staging
`,
    );
    await writeFile(
      path.join(root, ".env"),
      "SHARED=dotenv\nDOTENV_ONLY='from file'\nTYPESAFE_API_KEY=file-key\n",
    );
    const config = await loadProjectConfig(
      nested,
      { SHARED: "process", PROCESS_ONLY: "host" },
      {
        browser: "chrome",
        viewport: { width: 1440 },
        thresholds: { minP: 0.9 },
        outputDir: "cli-output",
      },
    );
    expect(config).toMatchObject({
      projectRoot: root,
      environment: "staging",
      browser: "chrome",
      viewport: { width: 1440, height: 700 },
      thresholds: { minP: 0.9, band: 0.1, contradictionCutoff: 0.4 },
      baseUrl: "https://staging.example/app/",
      apiKey: "file-key",
    });
    expect(config.outputDir).toBe(path.join(root, "cli-output"));
    expect(config.variables).toMatchObject({
      SHARED: "process",
      ROOT_ONLY: "root",
      NAMED_ONLY: "staging",
      DOTENV_ONLY: "from file",
      PROCESS_ONLY: "host",
    });
  });

  it("never searches a sibling .env and lets process values beat the root file", async () => {
    const parent = await temporaryRoot();
    const project = path.join(parent, "project");
    const sibling = path.join(parent, "sibling");
    await mkdir(project);
    await mkdir(sibling);
    await writeFile(path.join(project, "sedum.config.yaml"), "{}\n");
    await writeFile(
      path.join(project, ".env"),
      "VALUE=root\nTYPESAFE_API_KEY=root-key\n",
    );
    await writeFile(path.join(sibling, ".env"), "SIBLING=secret\n");
    const config = await loadProjectConfig(project, {
      VALUE: "process",
      TYPESAFE_API_KEY: "process-key",
    });
    expect(config.variables.VALUE).toBe("process");
    expect(config.variables.SIBLING).toBeUndefined();
    expect(config.apiKey).toBe("process-key");
  });

  it("loads one complete custom provider connection with process precedence", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "sedum.config.yaml"), "{}\n");
    await writeFile(
      path.join(root, ".env"),
      "TYPESAFE_BASE_URL=https://file.example/api/\nTYPESAFE_DEFAULT_MODEL=file-model\nTYPESAFE_API_KEY=file-key\n",
    );
    const config = await loadProjectConfig(root, {
      TYPESAFE_BASE_URL: "https://process.example/api",
      TYPESAFE_DEFAULT_MODEL: "process-model",
      TYPESAFE_API_KEY: "process-key",
    });
    expect(config).toMatchObject({
      providerBaseUrl: "https://process.example/api",
      providerModel: "process-model",
      apiKey: "process-key",
    });
  });

  it("allows independent SDK-style provider overrides", async () => {
    const root = await temporaryRoot();
    await expect(
      loadProjectConfig(root, {
        TYPESAFE_API_KEY: "provider-key",
      }),
    ).resolves.toMatchObject({
      providerBaseUrl: "https://api.typesafe.ai",
      providerModel: "jev-latest",
      apiKey: "provider-key",
    });
    await expect(
      loadProjectConfig(root, {
        TYPESAFE_DEFAULT_MODEL: "jev-preview",
        TYPESAFE_API_KEY: "provider-key",
      }),
    ).resolves.toMatchObject({
      providerBaseUrl: "https://api.typesafe.ai",
      providerModel: "jev-preview",
      apiKey: "provider-key",
    });
    await expect(
      loadProjectConfig(root, {
        TYPESAFE_BASE_URL: "https://gateway.example",
        TYPESAFE_API_KEY: "gateway-key",
      }),
    ).resolves.toMatchObject({
      providerBaseUrl: "https://gateway.example",
      providerModel: "jev-latest",
      apiKey: "gateway-key",
    });
  });

  it("rejects unsafe custom provider URLs", async () => {
    const root = await temporaryRoot();
    await expect(
      loadProjectConfig(root, {
        TYPESAFE_BASE_URL: "https://key@gateway.example?secret=value",
        TYPESAFE_DEFAULT_MODEL: "model",
        TYPESAFE_API_KEY: "must-not-leak",
      }),
    ).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_provider_url" }),
      ]),
    });
  });

  it("collects source-located actionable errors without exposing secret values", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      `browser: firefox
thresholds:
  verify: 0.2
  lowConfidenceBand: 0.4
variables:
  TYPESAFE_API_KEY: must-not-leak
unknownThing: true
environment: missing
`,
    );
    const error = await loadProjectConfig(root, {}).catch((value) => value);
    expect(error).toBeInstanceOf(ProjectConfigError);
    const diagnostics = (error as ProjectConfigError).diagnostics;
    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "unknown_config_key",
        "invalid_config_browser",
        "invalid_threshold_policy",
        "api_key_in_config",
        "unknown_config_environment",
      ]),
    );
    expect(
      diagnostics.every((item) => item.file.endsWith("sedum.config.yaml")),
    ).toBe(true);
    expect(diagnostics.every((item) => item.line > 0 && item.col > 0)).toBe(
      true,
    );
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
  });

  it("rejects paths and globs that escape the project", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      `tests:
  directory: ../outside
  include: ["../*.test.yaml"]
outputDir: /tmp/sedum-runs
`,
    );
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "config_path_escape" }),
        expect.objectContaining({ code: "unsafe_config_glob" }),
        expect.objectContaining({ code: "invalid_config_path" }),
      ]),
    });
  });

  it("rejects YAML aliases and explicit tags", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      `viewport: &viewport { width: 800, height: 600 }
variables:
  COPY: *viewport
baseUrl: !custom https://example.com/
`,
    );
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_config_alias" }),
        expect.objectContaining({ code: "unsupported_config_tag" }),
      ]),
    });
  });

  it("discovers sorted included tests, applies excludes, and ignores symlinked directories", async () => {
    const root = await temporaryRoot();
    const tests = path.join(root, "tests");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(path.join(tests, "checkout"), { recursive: true });
    await mkdir(elsewhere);
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      `tests:
  include: ["**/*.test.yaml"]
  exclude: ["**/skip-*.test.yaml"]
`,
    );
    await writeFile(path.join(tests, "z.test.yaml"), "steps: [verify z]\n");
    await writeFile(
      path.join(tests, "checkout", "a.test.yaml"),
      "steps: [verify a]\n",
    );
    await writeFile(
      path.join(tests, "skip-this.test.yaml"),
      "steps: [verify skip]\n",
    );
    await writeFile(
      path.join(elsewhere, "linked.test.yaml"),
      "steps: [verify linked]\n",
    );
    await symlink(elsewhere, path.join(tests, "linked"));
    const config = await loadProjectConfig(root, {});
    expect(await discoverConfiguredTests(config)).toEqual([
      path.join(tests, "checkout", "a.test.yaml"),
      path.join(tests, "z.test.yaml"),
    ]);
  });
});
