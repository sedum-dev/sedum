import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { BrowserDriverError } from "./browser-driver.js";
import { resolveEntryUrl, runFlow } from "./flow-runner.js";

describe("entry URL resolution", () => {
  it("preserves absolute URLs and resolves relative or omitted URLs against baseUrl", () => {
    expect(
      resolveEntryUrl("https://absolute.test/login", "https://base.test/app/"),
    ).toBe("https://absolute.test/login");
    expect(resolveEntryUrl("login", "https://base.test/app/")).toBe(
      "https://base.test/app/login",
    );
    expect(resolveEntryUrl("/login", "https://base.test/app/")).toBe(
      "https://base.test/login",
    );
    expect(resolveEntryUrl(undefined, "https://base.test/app/")).toBe(
      "https://base.test/app/",
    );
    expect(() => resolveEntryUrl("login")).toThrow("no baseUrl");
    expect(() => resolveEntryUrl()).toThrow("no URL and no baseUrl");
  });

  it("overrides only the entry origin and keeps the resolved path and query", () => {
    expect(
      resolveEntryUrl(
        "https://old.test/login?token=abc#done",
        undefined,
        "https://preview.test/app",
      ),
    ).toBe("https://preview.test/login?token=abc#done");
    expect(
      resolveEntryUrl(
        "/cart",
        "https://staging.test/app/",
        "https://preview.test",
      ),
    ).toBe("https://preview.test/cart");
    expect(() =>
      resolveEntryUrl(undefined, undefined, "https://preview.test/app/"),
    ).toThrow("no URL and no baseUrl");
    expect(() =>
      resolveEntryUrl("login", undefined, "https://preview.test/app/"),
    ).toThrow("no baseUrl");
    expect(() =>
      resolveEntryUrl("/login", "https://staging.test", "file:///tmp/page"),
    ).toThrow("HTTP or HTTPS");
  });
});

describe("walking-skeleton flow runner", () => {
  it("runs hook flows through the browser lifecycle", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "sedum-runner-"));
    try {
      const file = path.join(folder, "hooks.test.yaml");
      await writeFile(
        file,
        "before:\n  - click the banner\nsteps:\n  - click the login button\n",
      );
      const page = { close: vi.fn(async () => {}) };
      const context = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {}),
      };
      const session = {
        newContext: vi.fn(async () => context),
        close: vi.fn(async () => {}),
      };
      const launch = vi.fn(async () => session);
      const result = await runFlow(file, {
        repoRoot: folder,
        browser: { launch } as never,
        provider: {
          classifyBatch: vi.fn(),
          choose: vi.fn(),
          holds: vi.fn(),
        },
        classificationCache: new NoopClassificationCache(),
        env: {},
        baseUrl: "https://example.com/",
      });
      expect(result.status).toBe("could_not_run");
      expect(launch).toHaveBeenCalledOnce();
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("does not launch a browser when runtime data is unavailable", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "sedum-runner-"));
    try {
      const file = path.join(folder, "missing-data.test.yaml");
      await writeFile(
        file,
        "url: https://example.com/\ndata:\n  password: $SECRET\nsteps:\n  - type {{password}} in the password field\n",
      );
      const launch = vi.fn();
      const result = await runFlow(file, {
        repoRoot: folder,
        browser: { launch } as never,
        provider: {
          classifyBatch: vi.fn(),
          choose: vi.fn(),
          holds: vi.fn(),
        },
        classificationCache: new NoopClassificationCache(),
        env: {},
      });
      expect(result).toMatchObject({ status: "could_not_run" });
      expect(result.status === "could_not_run" && result.message).toContain(
        "$SECRET",
      );
      expect(launch).not.toHaveBeenCalled();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("passes the temporary headed launch policy to the driver", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "sedum-runner-"));
    try {
      const file = path.join(folder, "measure.test.yaml");
      await writeFile(
        file,
        "url: https://example.com/\nsteps:\n  - measure the page title\n",
      );
      const page = { close: vi.fn(async () => {}) };
      const context = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => {}),
      };
      const session = {
        newContext: vi.fn(async () => context),
        close: vi.fn(async () => {}),
      };
      const launch = vi.fn(async () => session);
      const result = await runFlow(file, {
        repoRoot: folder,
        browser: { launch } as never,
        provider: {
          classifyBatch: vi.fn(),
          choose: vi.fn(),
          holds: vi.fn(),
        },
        classificationCache: new NoopClassificationCache(),
        env: {},
        headless: false,
      });
      expect(result).toMatchObject({ status: "could_not_run" });
      expect(launch).toHaveBeenCalledWith({ headless: false });
      expect(page.close).toHaveBeenCalledOnce();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("replaces arbitrary browser failures with typed bounded diagnostics", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "sedum-runner-"));
    try {
      const file = path.join(folder, "measure.test.yaml");
      await writeFile(
        file,
        "url: https://example.com/\nsteps:\n  - measure the page title\n",
      );
      const result = await runFlow(file, {
        repoRoot: folder,
        browser: {
          launch: vi.fn(async () => {
            throw new BrowserDriverError(
              "operation-failed",
              `${"x".repeat(700)} sentinel-secret`,
            );
          }),
        } as never,
        provider: {
          classifyBatch: vi.fn(),
          choose: vi.fn(),
          holds: vi.fn(),
        },
        classificationCache: new NoopClassificationCache(),
        env: {},
      });
      expect(result).toMatchObject({
        status: "could_not_run",
        code: "operation-failed",
        message: "A browser operation could not be completed safely.",
      });
      expect(JSON.stringify(result)).not.toContain("sentinel-secret");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
