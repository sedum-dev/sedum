import { describe, expect, it, vi } from "vitest";
import type { ResolvedProjectConfig } from "./config.js";

const constructed = vi.hoisted(() => ({
  clef: [] as Record<string, unknown>[],
  typesafe: [] as Record<string, unknown>[],
}));

vi.mock("@sedum-dev/provider-clef", () => ({
  ClefAdapter: class {
    constructor(options: Record<string, unknown>) {
      constructed.clef.push(options);
    }
  },
}));

vi.mock("@sedum-dev/provider-typesafe", () => ({
  TypeSafeAdapter: class {
    constructor(options: Record<string, unknown>) {
      constructed.typesafe.push(options);
    }
  },
}));

import { createCliProvider } from "./provider-factory.js";

function config(name: "typesafe" | "clef"): ResolvedProjectConfig {
  return {
    projectRoot: "/project",
    configPath: null,
    environment: null,
    testDirectory: "/project/tests",
    include: [],
    exclude: [],
    affected: { ignore: [] },
    browser: "chrome",
    viewport: { width: 1280, height: 900 },
    thresholds: { minP: 0.75, band: 0.15, contradictionCutoff: 0.5 },
    outputDir: "/project/.sedum/runs",
    reporterDir: "/project/.sedum/reports",
    baseUrl: null,
    variables: {},
    providerName: name,
    apiKey: "key",
    cloudflareAccountId:
      name === "clef" ? "0123456789abcdef0123456789abcdef" : undefined,
    providerBaseUrl: "https://api.typesafe.ai",
    providerModel: name === "clef" ? "clef" : "jev-latest",
    vision: { enabled: false, model: "vision", timeoutMs: 10_000 },
    visionApiKey: undefined,
  };
}

describe("CLI provider factory", () => {
  it("constructs only Clef when Clef is selected", async () => {
    constructed.clef.length = 0;
    constructed.typesafe.length = 0;
    await createCliProvider(config("clef"));
    expect(constructed.typesafe).toEqual([]);
    expect(constructed.clef).toEqual([
      expect.objectContaining({
        accountId: "0123456789abcdef0123456789abcdef",
        apiKey: "key",
        model: "clef",
      }),
    ]);
    expect(constructed.clef[0]).not.toHaveProperty("baseURL");
  });

  it("preserves the legacy TypeSafe default route", async () => {
    constructed.clef.length = 0;
    constructed.typesafe.length = 0;
    await createCliProvider(config("typesafe"));
    expect(constructed.clef).toEqual([]);
    expect(constructed.typesafe).toEqual([
      expect.objectContaining({
        apiKey: "key",
        baseURL: "https://api.typesafe.ai",
        model: "jev-latest",
      }),
    ]);
    expect(constructed.typesafe[0]).not.toHaveProperty("accountId");
  });
});
