import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";
import { ProviderError, type ProviderErrorCode } from "./provider.js";

async function runWithFailingProvider(step: string, code: ProviderErrorCode) {
  const root = await mkdtemp(path.join(tmpdir(), "sedum-provider-"));
  try {
    const file = path.join(root, "main.test.yaml");
    await writeFile(file, `steps:\n  - ${step}\n`);
    const version = {
      document: "doc-1",
      route: "https://example.test/",
      revision: 1,
    };
    const candidates = ["Login", "Help"].map((name, index) => ({
      ref: `ref-${index}`,
      tag: "button",
      role: "button",
      name,
      peers: [],
      editable: false,
      disabled: false,
      inputType: "",
      signals: { path: `html/body/button:${index}` },
    }));
    const page = {
      url: version.route,
      closed: false,
      title: vi.fn(async () => "Example"),
      text: vi.fn(async () => "Example"),
      settle: vi.fn(async () => ({ settled: true, elapsedMs: 1 })),
      goto: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      evaluate: vi.fn(async (expression: string) => {
        const value = expression.includes('bridge["quiet"]')
          ? { quiet: true, version }
          : expression.includes('bridge["collect"]')
            ? {
                protocol: 1,
                version,
                total: candidates.length,
                offset: 0,
                next: null,
                complete: true,
                candidates,
              }
            : expression.includes('bridge["digest"]')
              ? { protocol: 1, version, text: "Example", complete: true }
              : version;
        return { installed: true, protocol: 1, value };
      }),
    };
    const session = {
      newContext: vi.fn(async () => ({
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {}),
      })),
      close: vi.fn(async () => {}),
    };
    const fail = async () => {
      throw new ProviderError(code, "provider failed");
    };
    return await runFlow(file, {
      repoRoot: root,
      browser: { launch: vi.fn(async () => session) } as never,
      provider: { classifyBatch: vi.fn(), choose: fail, holds: fail },
      classificationCache: new NoopClassificationCache(),
      env: {},
      baseUrl: version.route,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("provider failures that affect the whole run", () => {
  it.each([
    ["click the login button", "authentication", "provider_authentication"],
    ["click the login button", "configuration", "provider_configuration"],
    ["click the login button", "rate-limited", "provider_rate_limited"],
    [
      "verify the page says Example",
      "authentication",
      "provider_authentication",
    ],
  ] as const)(
    "reports `%s` with a %s error as %s",
    async (step, code, expected) => {
      const result = await runWithFailingProvider(step, code);
      expect(result).toMatchObject({ status: "could_not_run", code: expected });
    },
  );

  it("keeps other provider failures scoped to the step", async () => {
    const result = await runWithFailingProvider(
      "click the login button",
      "timeout",
    );
    expect(result).toMatchObject({
      status: "could_not_run",
      code: "unsupported_test",
    });
  });
});
