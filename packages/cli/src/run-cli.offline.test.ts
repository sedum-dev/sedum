import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Loading either module would mean an offline command pulled in provider or
// browser construction code.
vi.mock("@sedum-dev/provider-typesafe", () => {
  throw new Error("offline commands must not load the provider package");
});
vi.mock("./run-command.js", () => {
  throw new Error("offline commands must not load the run command");
});

const { runCli } = await import("./run-cli.js");

let root: string | undefined;
const originalEnv = process.env;
afterEach(async () => {
  process.env = originalEnv;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("offline validate and list", () => {
  it("load no provider or run code, read no API key, and write no cache", async () => {
    root = await mkdtemp(path.join(tmpdir(), "sedum-offline-"));
    await mkdir(path.join(root, "tests"));
    await mkdir(path.join(root, ".sedum"));
    await writeFile(
      path.join(root, "tests", "login.test.yaml"),
      "url: https://example.test\ndata: {password: $SEDUM_TEST_UNSET_VARIABLE}\nsteps:\n  - type {{password}} in the password field\n  - add the cheapest item to the basket\n",
    );
    const cachePath = path.join(root, ".sedum", "classifications.json");
    await writeFile(cachePath, "{}");
    const before = await stat(cachePath);

    const reads = new Set<string>();
    const env = new Proxy(process.env, {
      get(target, key, receiver) {
        if (typeof key === "string") reads.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    process.env = env;
    const createClassificationProvider = vi.fn(() => {
      throw new Error("not offline");
    });

    const validate = await runCli(["validate"], "0.0.0", {
      cwd: root,
      createClassificationProvider,
    });
    const list = await runCli(["list", "--json"], "0.0.0", { cwd: root });

    expect(validate.exitCode).toBe(1);
    expect(validate.stdout).toContain("not checked offline");
    expect(list.exitCode).toBe(0);
    expect(createClassificationProvider).not.toHaveBeenCalled();
    expect(reads.has("TYPESAFE_API_KEY")).toBe(false);
    expect(reads.has("SEDUM_TEST_UNSET_VARIABLE")).toBe(false);
    expect(await readFile(cachePath, "utf8")).toBe("{}");
    expect((await stat(cachePath)).mtimeMs).toBe(before.mtimeMs);
  });
});
