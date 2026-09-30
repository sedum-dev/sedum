import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  JudgePageDigest,
  ProviderCall,
  ResolverCandidates,
} from "@sedum-dev/core";
import {
  startFixtureSite,
  type FixtureSite,
} from "../../../fixtures/site/server.js";
import { runExitCode } from "./exit-policy.js";

const call: ProviderCall = {
  requestedModel: "fake",
  model: "fake",
  attempts: 1,
  usage: { inputTokens: 3, outputTokens: 1 },
  rate: null,
  successfulResponseCostUsd: 0,
  totalCostUsd: 0,
};

const seen = vi.hoisted(() => ({
  sentences: [] as string[],
  claims: [] as string[],
}));

/**
 * A deterministic stand-in for the model: pick the candidate the sentence
 * names (and, among equal names, the one whose item the sentence mentions),
 * and judge `the page shows X` by whether the page text contains X.
 */
vi.mock("@sedum-dev/provider-typesafe", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@sedum-dev/provider-typesafe")>();
  class FakeAdapter {
    async classifyBatch(): Promise<never> {
      throw new Error("Every sentence in these tests matches a pattern.");
    }
    async choose(sentence: string, offered: ResolverCandidates) {
      seen.sentences.push(sentence);
      const wanted = sentence.toLowerCase();
      const candidates = offered.options.flatMap((option) =>
        option.kind === "candidate" ? [option.candidate] : [],
      );
      const named = candidates.filter((candidate) =>
        wanted.includes(candidate.name.toLowerCase()),
      );
      const picked =
        named.find((candidate) =>
          candidate.peers.some((peer) => wanted.includes(peer.toLowerCase())),
        ) ?? named.sort((a, b) => b.name.length - a.name.length)[0];
      const ids = [...candidates.map((candidate) => candidate.id), "none"];
      const selected = picked?.id ?? "none";
      return {
        selection:
          selected === "none"
            ? ({ kind: "none" } as const)
            : ({ kind: "candidate", id: selected } as const),
        probabilities: Object.fromEntries(
          ids.map((id) => [
            id,
            id === selected ? 0.96 : 0.04 / (ids.length - 1),
          ]),
        ),
        confidence: null,
        call,
      };
    }
    async holds(claim: string, digest: JudgePageDigest) {
      seen.claims.push(claim);
      const found = digest.text.includes(
        /shows\s+(.+)$/u.exec(claim)?.[1] ?? claim,
      );
      return {
        holds: found ? 0.97 : 0.02,
        contradicted: found ? 0.01 : 0.9,
        call,
      };
    }
  }
  return { ...actual, TypeSafeAdapter: FakeAdapter };
});

import { executeListCommand } from "./list-command.js";
import { executeRunCommand } from "./run-command.js";
import { executeValidateCommand } from "./validate-command.js";

const cliPackage = fileURLToPath(new URL("..", import.meta.url));

const SHOP = `import { test, expect, secret } from "sedum-cli";

test("signs in and adds a backpack", { url: "/login", tags: ["cart"] }, async ({ page, ai, env }) => {
  await ai.group("Log in", [
    "type {{user}} into the Username field",
    "type {{password}} into the Password field",
    "click the Login button",
  ], { user: "fixture_user", password: secret(env.FIXTURE_PASSWORD!) });
  await expect(page).toHaveURL(/products$/);
  await ai("click the Add to cart button for {{product}}", { product: "Canvas Backpack" });
  expect(await page.evaluate(() => sessionStorage.getItem("cart"))).toBe('["Canvas Backpack"]');
  await ai("verify the page shows Canvas Backpack added to cart");
});

test("skips the login form", { url: "/login" }, async ({ page, ai }) => {
  await page.evaluate(() => sessionStorage.setItem("signed-in", "yes"));
  await page.goto(new URL("/products", page.url()).href);
  await ai("verify the page shows Trail Light");
});

test("a wrong claim fails", { url: "/help", tags: ["broken"] }, async ({ ai }) => {
  await ai("verify the page shows Order placed");
});
`;

describe.skipIf(process.env.SEDUM_BROWSER_INTEGRATION !== "1")(
  "TypeScript tests through the CLI",
  () => {
    let site: FixtureSite;
    let root = "";
    let previous = "";

    beforeAll(async () => {
      site = await startFixtureSite();
      root = await mkdtemp(path.join(tmpdir(), "sedum-script-cli-"));
      // The project imports the CLI package exactly as an installed project does.
      await mkdir(path.join(root, "node_modules"));
      await symlink(
        cliPackage,
        path.join(root, "node_modules", "sedum-cli"),
        "junction",
      );
      await mkdir(path.join(root, "tests"));
      await writeFile(
        path.join(root, "sedum.config.yaml"),
        `baseUrl: ${site.baseUrl}\nbrowser: chromium\ntests:\n  directory: tests\n`,
      );
      await writeFile(path.join(root, "tests", "shop.test.ts"), SHOP);
      await writeFile(
        path.join(root, "tests", "help.test.yaml"),
        "url: /help\nsteps:\n  - verify the page shows Returns\n",
      );
      process.env.FIXTURE_PASSWORD = "fixture_password";
      previous = process.cwd();
      process.chdir(root);
    });

    afterAll(async () => {
      if (previous) process.chdir(previous);
      delete process.env.FIXTURE_PASSWORD;
      await site?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("lists every test() beside YAML tests", async () => {
      const listed = await executeListCommand({ paths: [], cwd: root });
      expect(listed.listing?.invalid).toEqual([]);
      expect(
        listed.listing?.tests.map((test) => [test.id, test.file, test.tags]),
      ).toEqual([
        ["tests/help.test.yaml", "tests/help.test.yaml", []],
        [
          "tests/shop.test.ts#signs in and adds a backpack",
          "tests/shop.test.ts",
          ["cart"],
        ],
        ["tests/shop.test.ts#skips the login form", "tests/shop.test.ts", []],
        [
          "tests/shop.test.ts#a wrong claim fails",
          "tests/shop.test.ts",
          ["broken"],
        ],
      ]);
    });

    it("validates the literal sentences offline", async () => {
      const validated = await executeValidateCommand({
        paths: [],
        online: false,
        cwd: root,
        createProvider: () => {
          throw new Error("offline");
        },
      });
      expect(validated.result?.diagnostics).toEqual([]);
      expect(validated.result?.fullyValidated).toBe(true);
      expect(validated.result?.counts.tests).toBe(2);
    });

    it("runs selected tests with titles, groups, and redacted secrets", async () => {
      const output = await executeRunCommand({
        paths: [],
        filters: { labels: [], names: ["backpack", "login form"] },
        evidence: true,
        replay: false,
        sensitiveOrigins: [],
        locatorCacheDisabled: true,
        reporters: ["json", "markdown", "junit"],
      });
      expect(output.diagnostic).toBeNull();
      expect(runExitCode(output.result, false)).toBe(0);
      expect(
        output.result.tests.map((test) => [test.id, test.verdict]),
      ).toEqual([
        ["tests/shop.test.ts#signs in and adds a backpack", "passed"],
        ["tests/shop.test.ts#skips the login form", "passed"],
      ]);
      const steps = output.result.tests[0]!.attempts[0]!.steps;
      expect(steps.map((step) => [step.sentence, step.group])).toEqual([
        ["type {{user}} into the Username field", ["Log in"]],
        ["type {{password}} into the Password field", ["Log in"]],
        ["click the Login button", ["Log in"]],
        ["click the Add to cart button for Canvas Backpack", undefined],
        ["verify the page shows Canvas Backpack added to cart", undefined],
      ]);
      expect(seen.sentences).toContain(
        "click the Add to cart button for Canvas Backpack",
      );
      expect(JSON.stringify(output.result)).not.toContain("fixture_password");
      const markdown = await readFile(output.artifacts.markdownPath!, "utf8");
      expect(markdown).not.toContain("fixture_password");
      const junit = await readFile(output.artifacts.junitPath!, "utf8");
      expect(junit).toContain("signs in and adds a backpack");
    }, 60_000);

    it("fails a wrong claim and names the test to rerun", async () => {
      const output = await executeRunCommand({
        paths: ["tests/shop.test.ts"],
        filters: { labels: ["broken"], names: [] },
        evidence: false,
        replay: false,
        sensitiveOrigins: [],
        locatorCacheDisabled: true,
        reporters: ["markdown"],
      });
      expect(output.diagnostic).toBeNull();
      expect(runExitCode(output.result, false)).toBe(1);
      const markdown = await readFile(output.artifacts.markdownPath!, "utf8");
      expect(markdown).toContain(
        "sedum run 'tests/shop.test.ts' --name 'a wrong claim fails'",
      );
      expect(markdown).toContain("tests/shop.test.ts › a wrong claim fails");
    }, 60_000);
  },
);
