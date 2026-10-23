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
  it.each(["constructor", "toString", "__proto__"])(
    "resolves the valid credential name %s without inherited properties",
    async (name) => {
      const root = await temporaryRoot();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        `provider: { apiKeyEnv: ${name} }\n`,
      );
      const offline = await loadProjectConfig(
        root,
        {},
        {},
        { readEnvironmentFile: false },
      );
      expect(offline.apiKey).toBeUndefined();
      const fromProcess = await loadProjectConfig(root, {
        [name]: "process-sentinel",
      });
      expect(fromProcess.apiKey).toBe("process-sentinel");
    },
  );

  it.each(["constructor", "toString"])(
    "resolves the own credential name %s from .env",
    async (name) => {
      const root = await temporaryRoot();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        `provider: { apiKeyEnv: ${name} }\n`,
      );
      await writeFile(path.join(root, ".env"), `${name}=file-sentinel\n`);
      const fromFile = await loadProjectConfig(root, {});
      expect(fromFile.apiKey).toBe("file-sentinel");
    },
  );

  it.each(["typesafe", "openrouter", "clef"])(
    "resolves a custom %s key with environment and source precedence",
    async (name) => {
      const root = await temporaryRoot();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        `
provider: { name: ${name}, apiKeyEnv: FOO }
environments:
  local:
    provider: { apiKeyEnv: LOCAL_FOO }
  staging: {}
`,
      );
      await writeFile(
        path.join(root, ".env"),
        "FOO=file-key\nLOCAL_FOO=local-key\n",
      );
      const host = { FOO: " process-key " };
      const top = await loadProjectConfig(root, host);
      expect(top.apiKey).toBe("process-key");
      expect(top.variables.FOO).toBeUndefined();
      expect(top.variables.LOCAL_FOO).toBeUndefined();
      expect(
        (await loadProjectConfig(root, {}, { environment: "staging" })).apiKey,
      ).toBe("file-key");
      const local = await loadProjectConfig(root, host, {
        environment: "local",
      });
      expect(local.apiKey).toBe("local-key");
      await writeFile(path.join(root, ".env"), "");
      const missing = await loadProjectConfig(root, {
        TYPESAFE_API_KEY: "wrong",
        OPENROUTER_API_KEY: "wrong",
        CLOUDFLARE_AUTH_TOKEN: "wrong",
      });
      expect(missing.apiKey).toBeUndefined();
    },
  );

  it.each(["provider", "environments.local.provider"])(
    "rejects invalid variable names in %s even in unselected environments",
    async (key) => {
      const root = await temporaryRoot();
      for (const value of ["BAD-NAME", "1KEY", "", null, 42]) {
        const raw = key.startsWith("environments")
          ? {
              environments: {
                local: { [key.split(".")[2]!]: { apiKeyEnv: value } },
              },
            }
          : { [key]: { apiKeyEnv: value } };
        await writeFile(
          path.join(root, "sedum.config.yaml"),
          JSON.stringify(raw),
        );
        await expect(
          loadProjectConfig(root, {}, {}, { readEnvironmentFile: false }),
        ).rejects.toMatchObject({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              code: "invalid_config_env_name",
              key: `${key}.apiKeyEnv`,
            }),
          ]),
        });
      }
    },
  );

  it("rejects custom credentials stored as test variables", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider: { apiKeyEnv: FOO }\nenvironments:\n  local:\n    variables: { FOO: forbidden }\n",
    );
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: "api_key_in_config",
          key: "environments.local.variables.FOO",
        }),
      ]),
    });
  });

  it("validates and freezes default-empty affected ignores", async () => {
    const root = await temporaryRoot();
    expect((await loadProjectConfig(root, {})).affected.ignore).toEqual([]);
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      'affected:\n  ignore: ["docs/", "**/*.lock", ".env"]\n',
    );
    const config = await loadProjectConfig(root, {});
    expect(config.affected.ignore).toEqual(["docs/", "**/*.lock", ".env"]);
    expect(Object.isFrozen(config.affected.ignore)).toBe(true);
    for (const yaml of [
      "affected: []",
      "affected: { unknown: [] }",
      "affected: { ignore: nope }",
      'affected: { ignore: [" "] }',
      'affected: { ignore: ["[broken"] }',
      'affected: { ignore: ["../outside"] }',
    ]) {
      await writeFile(path.join(root, "sedum.config.yaml"), yaml);
      await expect(loadProjectConfig(root, {})).rejects.toBeInstanceOf(
        ProjectConfigError,
      );
    }
  });

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
      providerName: "typesafe",
      providerBaseUrl: "https://api.typesafe.ai",
      providerModel: "jev-latest",
      vision: { enabled: false },
    });
    expect(config.testDirectory).toBe(path.join(root, "tests"));
    expect(config.outputDir).toBe(path.join(root, ".sedum", "runs"));
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.thresholds)).toBe(true);
  });

  it.each(["SEDUM_UPLOAD_TOKEN", "SEDUM_READ_TOKEN"])(
    "keeps %s out of test variables and YAML configuration",
    async (name) => {
      const root = await temporaryRoot();
      await writeFile(path.join(root, ".env"), `${name}=dotenv-secret\n`);
      expect(
        (await loadProjectConfig(root, {})).variables[name],
      ).toBeUndefined();
      expect(
        (await loadProjectConfig(root, { [name]: "process-secret" })).variables[
          name
        ],
      ).toBeUndefined();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        `variables:\n  ${name}: yaml-secret\n`,
      );
      try {
        await loadProjectConfig(root, {});
        expect.fail("integration credentials must be rejected in YAML");
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectConfigError);
        expect((error as ProjectConfigError).diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "api_key_in_config",
              key: `variables.${name}`,
            }),
          ]),
        );
        expect(JSON.stringify(error)).not.toContain("yaml-secret");
      }
    },
  );

  it("picks the browser from the flag, SEDUM_BROWSER, the environment, then the root key", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "browser: chrome\nenvironment: ci\nenvironments:\n  ci:\n    browser: chromium\n  local: {}\n",
    );
    const pick = async (
      host: Record<string, string>,
      overrides: Parameters<typeof loadProjectConfig>[2] = {},
    ) => {
      const config = await loadProjectConfig(root, host, overrides);
      return [config.browser, config.browserSource];
    };
    expect(await pick({})).toEqual(["chromium", "environments.ci.browser"]);
    expect(await pick({}, { environment: "local" })).toEqual([
      "chrome",
      "browser",
    ]);
    expect(await pick({ SEDUM_BROWSER: "chrome" })).toEqual([
      "chrome",
      "SEDUM_BROWSER",
    ]);
    expect(
      await pick({ SEDUM_BROWSER: "chrome" }, { browser: "chromium" }),
    ).toEqual(["chromium", "--browser"]);
    expect(await pick({ SEDUM_BROWSER: " " })).toEqual([
      "chromium",
      "environments.ci.browser",
    ]);
  });

  it("reads SEDUM_BROWSER from the project .env below the process environment", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, ".env"), "SEDUM_BROWSER=chromium\n");
    const fromFile = await loadProjectConfig(root, {});
    expect([fromFile.browser, fromFile.browserSource]).toEqual([
      "chromium",
      "SEDUM_BROWSER",
    ]);
    const fromHost = await loadProjectConfig(root, { SEDUM_BROWSER: "chrome" });
    expect(fromHost.browser).toBe("chrome");
    const noFile = await loadProjectConfig(
      root,
      {},
      {},
      { readEnvironmentFile: false },
    );
    expect([noFile.browser, noFile.browserSource]).toEqual([
      "chrome",
      "default",
    ]);
  });

  it("checks every environment's browser, selected or not, whatever overrides it", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "browser: chromiun\nenvironments:\n  ci:\n    browser: firefox\n  local:\n    browser: chromium\n",
    );
    const error = await loadProjectConfig(
      root,
      { SEDUM_BROWSER: "chromium" },
      { browser: "chrome" },
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ProjectConfigError);
    expect(
      (error as ProjectConfigError).diagnostics.map((item) => [
        item.key,
        item.line,
      ]),
    ).toEqual([
      ["browser", 1],
      ["environments.ci.browser", 4],
    ]);
  });

  it("names the source of an unsupported browser", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "environment: ci\nenvironments:\n  ci:\n    browser: firefox\n",
    );
    const keys = async (host: Record<string, string>) => {
      const error = await loadProjectConfig(root, host).catch(
        (value: unknown) => value,
      );
      expect(error).toBeInstanceOf(ProjectConfigError);
      return (error as ProjectConfigError).diagnostics
        .filter((item) => item.code === "invalid_config_browser")
        .map((item) => item.key);
    };
    expect(await keys({})).toEqual(["environments.ci.browser"]);
    // A higher-precedence setting does not hide a bad key in the shared config.
    expect(await keys({ SEDUM_BROWSER: "safari" })).toEqual([
      "environments.ci.browser",
      "SEDUM_BROWSER",
    ]);
    const fromProcess = await loadProjectConfig(root, {
      SEDUM_BROWSER: "safari",
    }).catch((value: unknown) => value);
    expect(
      (fromProcess as ProjectConfigError).diagnostics.find(
        (item) => item.key === "SEDUM_BROWSER",
      )?.file,
    ).toBe("<process environment>");
    await writeFile(path.join(root, ".env"), "SEDUM_BROWSER=safari\n");
    const error = await loadProjectConfig(root, {}).catch(
      (value: unknown) => value,
    );
    expect(
      (error as ProjectConfigError).diagnostics.find(
        (item) => item.key === "SEDUM_BROWSER",
      )?.file,
    ).toBe(path.join(root, ".env"));
  });

  it("selects Clef credentials and excludes Cloudflare secrets from test variables", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider:\n  name: clef\n  model: clef-flash\n",
    );
    const config = await loadProjectConfig(root, {
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_AUTH_TOKEN: "cloudflare-secret",
      TYPESAFE_API_KEY: "ignored-typesafe-secret",
    });
    expect(config).toMatchObject({
      providerName: "clef",
      providerModel: "clef-flash",
      cloudflareAccountId: "0123456789abcdef0123456789abcdef",
      apiKey: "cloudflare-secret",
    });
    expect(config.variables.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(config.variables.CLOUDFLARE_AUTH_TOKEN).toBeUndefined();
    expect(config.variables.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });

  it.each(["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"])(
    "selects OpenRouter using %s without inheriting TypeSafe settings",
    async (name) => {
      const root = await temporaryRoot();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        "provider: { name: openrouter }\n",
      );
      await writeFile(path.join(root, ".env"), "OPENROUTER_API_KEY=file-key\n");
      const config = await loadProjectConfig(root, {
        [name]: "host-key",
        TYPESAFE_API_KEY: "wrong-key",
        TYPESAFE_BASE_URL: "https://wrong.example",
        TYPESAFE_DEFAULT_MODEL: "wrong-model",
      });
      expect(config).toMatchObject({
        providerName: "openrouter",
        providerBaseUrl: "https://openrouter.ai/api",
        providerModel: "typesafe/jev-1.13",
        apiKey: "host-key",
        vision: { enabled: false },
      });
      expect(config.variables[name]).toBeUndefined();
      expect(config.variables.OPENROUTER_API_KEY).toBeUndefined();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        "provider: { name: openrouter, model: cloudflare/clef-flash }\n",
      );
      expect((await loadProjectConfig(root, {})).providerModel).toBe(
        "cloudflare/clef-flash",
      );
    },
  );

  it("does not substitute TypeSafe credentials when the OpenRouter key is missing", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider: { name: openrouter }\n",
    );
    expect(
      (await loadProjectConfig(root, { TYPESAFE_API_KEY: "wrong-key" })).apiKey,
    ).toBeUndefined();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "variables: { OPENROUTER_API_KEY: forbidden-key }\n",
    );
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "api_key_in_config" })],
    });
  });

  it.each(["CLOUDFLARE_AUTH_TOKEN", "CLOUDFLARE_API_TOKEN"])(
    "accepts the Clef token from %s in the project .env",
    async (name) => {
      const root = await temporaryRoot();
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        "provider: { name: clef, model: clef }\n",
      );
      await writeFile(
        path.join(root, ".env"),
        `CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef\n${name}=file-secret\n`,
      );
      const config = await loadProjectConfig(root, {});
      expect(config.apiKey).toBe("file-secret");
      expect(config.variables[name]).toBeUndefined();
    },
  );

  it("applies process-over-.env precedence across both Cloudflare token names", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider: { name: clef, model: clef }\n",
    );
    await writeFile(
      path.join(root, ".env"),
      "CLOUDFLARE_AUTH_TOKEN=file-auth-secret\nCLOUDFLARE_API_TOKEN=file-api-secret\n",
    );
    await expect(
      loadProjectConfig(root, { CLOUDFLARE_API_TOKEN: "process-secret" }),
    ).resolves.toMatchObject({ apiKey: "process-secret" });
  });

  it("rejects conflicting Cloudflare token names at one precedence level without leaking either value", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider: { name: clef, model: clef }\n",
    );
    const error = await loadProjectConfig(root, {
      CLOUDFLARE_AUTH_TOKEN: "auth-sentinel-secret",
      CLOUDFLARE_API_TOKEN: "api-sentinel-secret",
    }).catch((value) => value);
    expect(error).toBeInstanceOf(ProjectConfigError);
    expect(error).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "conflicting_cloudflare_api_tokens",
          message: expect.stringContaining("CLOUDFLARE_API_TOKEN"),
        }),
      ],
    });
    expect(JSON.stringify(error)).not.toContain("sentinel-secret");
  });

  it("defaults Clef to clef and validates its account and model", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider:\n  name: clef\n",
    );
    await expect(loadProjectConfig(root, {})).resolves.toMatchObject({
      providerName: "clef",
      providerModel: "clef",
    });
    await expect(
      loadProjectConfig(root, { CLOUDFLARE_ACCOUNT_ID: "not-an-account" }),
    ).rejects.toBeInstanceOf(ProjectConfigError);
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "provider:\n  name: clef\n  model: arbitrary\n",
    );
    await expect(loadProjectConfig(root, {})).rejects.toBeInstanceOf(
      ProjectConfigError,
    );
  });

  it("suggests the intended key for a misspelt config key", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "sedum.config.yaml"), "browsr: chrome\n");
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "unknown_config_key",
          fix: "Did you mean `browser`?",
        }),
      ],
    });
  });

  it("turns screenshots on only for the direct TypeSafe API unless configured", async () => {
    const root = await temporaryRoot();
    const load = async (env: Record<string, string> = {}, config?: string) => {
      if (config !== undefined)
        await writeFile(path.join(root, "sedum.config.yaml"), config);
      return (await loadProjectConfig(root, env)).screenshots;
    };
    expect(await load()).toBe(true);
    expect(await load({ TYPESAFE_BASE_URL: "https://example.com" })).toBe(
      false,
    );
    expect(await load({}, "provider:\n  name: clef\n")).toBe(false);
    expect(await load({}, "screenshots: false\n")).toBe(false);
    expect(
      await load(
        { TYPESAFE_BASE_URL: "https://example.com" },
        "screenshots: true\n",
      ),
    ).toBe(true);
    await expect(
      loadProjectConfig(root, {}, { screenshots: false }),
    ).resolves.toMatchObject({ screenshots: false });
    await writeFile(path.join(root, "sedum.config.yaml"), "screenshots: yes\n");
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ key: "screenshots" })],
    });
  });

  it("resolves the step timeout per environment and rejects invalid ones", async () => {
    const root = await temporaryRoot();
    const load = async (config: string, environment?: string) => {
      await writeFile(path.join(root, "sedum.config.yaml"), config);
      return loadProjectConfig(root, {}, environment ? { environment } : {});
    };
    expect((await load("")).stepTimeoutMs).toBe(5_000);
    const config =
      "stepTimeoutMs: 30000\nenvironments:\n  ci: { stepTimeoutMs: 60000 }\n  local: {}\n";
    expect((await load(config)).stepTimeoutMs).toBe(30_000);
    expect((await load(config, "local")).stepTimeoutMs).toBe(30_000);
    expect((await load(config, "ci")).stepTimeoutMs).toBe(60_000);
    for (const value of ["-1", "120001", "30s"])
      await expect(load(`stepTimeoutMs: ${value}\n`)).rejects.toMatchObject({
        diagnostics: [expect.objectContaining({ key: "stepTimeoutMs" })],
      });
    // An unselected environment is checked too, so CI-only mistakes show locally.
    await expect(
      load("environments:\n  ci: { stepTimeoutMs: 30s }\n"),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ key: "environments.ci.stepTimeoutMs" }),
      ],
    });
    await expect(
      load("environment: ci\nenvironments:\n  ci: { stepTimeoutMs: 1.5 }\n"),
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ key: "environments.ci.stepTimeoutMs" }),
      ],
    });
  });

  it("validates vision settings and names the removed OpenRouter keys", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "sedum.config.yaml"),
      "vision:\n  enabled: true\n",
    );
    await expect(loadProjectConfig(root, {})).resolves.toMatchObject({
      vision: { enabled: true },
    });

    await writeFile(
      path.join(root, "sedum.config.yaml"),
      `vision:
  enabled: yes
  model: google/gemini-3.8-flash
  timeoutMs: 2500
  apiKeyEnv: SIGHT
  retry: true
constructor: 1
variables:
  OPEN_ROUTER_API_KEY: forbidden
`,
    );
    await expect(loadProjectConfig(root, {})).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          key: "vision.retry",
          code: "unknown_config_key",
        }),
        expect.objectContaining({ key: "vision.enabled" }),
        expect.objectContaining({
          key: "vision.model",
          code: "removed_config_key",
          fix: "Delete `vision.model` from sedum.config.yaml.",
        }),
        expect.objectContaining({
          key: "vision.timeoutMs",
          code: "removed_config_key",
        }),
        expect.objectContaining({
          key: "vision.apiKeyEnv",
          code: "removed_config_key",
        }),
        expect.objectContaining({
          key: "constructor",
          code: "unknown_config_key",
        }),
        expect.objectContaining({
          key: "variables.OPEN_ROUTER_API_KEY",
          code: "api_key_in_config",
        }),
      ]),
    });
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
