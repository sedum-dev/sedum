import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NoopClassificationCache } from "./classification-cache.js";
import { runFlow } from "./flow-runner.js";

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
        "data:\n  password: $SECRET\nsteps:\n  - type {{password}} in the password field\n",
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
      await writeFile(file, "steps:\n  - measure the page title\n");
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
});
