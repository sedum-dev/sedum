import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  test as propertyTest,
} from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { listTests } from "./project-listing.js";
import {
  checkRegistrations,
  isScriptTestFile,
  loadScriptFile,
  scriptListingEntries,
} from "./script-loader.js";
import type { ScriptRegistration } from "./script-registry.js";

const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 300,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const root = "/project";
const file = "/project/tests/shop.test.ts";
const body = async () => undefined;

function registration(
  title: unknown,
  options: unknown = {},
  line = 3,
): ScriptRegistration {
  return {
    title: title as string,
    options: options as ScriptRegistration["options"],
    body,
    callSite: `    at ${file}:${line}:1`,
  };
}

describe("checking registered script tests", () => {
  it("derives identity from the file and title unless an id is given", () => {
    const loaded = checkRegistrations(
      file,
      [
        registration("signs in", { url: "/login", tags: ["smoke"] }, 3),
        registration("checks out", { id: "checkout" }, 9),
      ],
      root,
    );
    expect(loaded.diagnostics).toEqual([]);
    expect(
      loaded.tests.map(({ identity, explicitId, url, tags, source }) => ({
        identity,
        explicitId,
        url,
        tags,
        line: source.line,
      })),
    ).toEqual([
      {
        identity: "tests/shop.test.ts#signs in",
        explicitId: undefined,
        url: "/login",
        tags: ["smoke"],
        line: 3,
      },
      {
        identity: "checkout",
        explicitId: "checkout",
        url: undefined,
        tags: [],
        line: 9,
      },
    ]);
  });

  it.each([
    ["no tests", [], "no_tests"],
    ["a blank title", [registration("  ")], "invalid_title"],
    [
      "a missing body",
      [{ ...registration("t"), body: undefined as never }],
      "missing_body",
    ],
    [
      "an unknown option",
      [registration("t", { retries: 2 })],
      "unknown_option",
    ],
    ["a bad id", [registration("t", { id: "has space" })], "invalid_id"],
    ["a blank url", [registration("t", { url: " " })], "invalid_url"],
    ["bad tags", [registration("t", { tags: ["a,b"] })], "invalid_tags"],
    [
      "a duplicate title",
      [registration("same", {}, 3), registration("same", {}, 5)],
      "duplicate_title",
    ],
    [
      "a duplicate id",
      [registration("a", { id: "x" }, 3), registration("b", { id: "x" }, 5)],
      "duplicate_id",
    ],
  ] as const)("rejects %s", (_name, registrations, code) => {
    const loaded = checkRegistrations(file, registrations, root);
    expect(loaded.diagnostics.map((item) => item.code)).toEqual([code]);
    expect(loaded.diagnostics[0]!.fix).not.toBe("");
  });

  propertyTest("distinct titles give distinct, stable identities", () => {
    hegel.test((tc) => {
      const titles = [
        ...new Set(
          tc
            .draw(
              gs.arrays(gs.text({ minSize: 1, maxSize: 30 }), { maxSize: 8 }),
            )
            .filter((title) => title.trim()),
        ),
      ];
      const loaded = checkRegistrations(
        file,
        titles.map((title, index) => registration(title, {}, index + 1)),
        root,
      );
      expect(loaded.tests.map((test) => test.identity)).toEqual(
        titles.map((title) => `tests/shop.test.ts#${title}`),
      );
      expect(loaded.diagnostics.map((item) => item.code)).toEqual(
        titles.length ? [] : ["no_tests"],
      );
      const listed = listTests(scriptListingEntries(loaded), {
        repoRoot: root,
      });
      expect(listed.tests.map((test) => test.id)).toEqual(
        titles.map((title) => `tests/shop.test.ts#${title}`),
      );
    }, propertySettings);
  });

  it("lists a file's own problems once, beside its valid tests", () => {
    const loaded = checkRegistrations(
      file,
      [registration("good", {}, 3), registration("bad", { retries: 1 }, 7)],
      root,
    );
    const listing = listTests(scriptListingEntries(loaded), { repoRoot: root });
    expect(listing.tests.map((test) => test.description)).toEqual(["good"]);
    expect(listing.invalid).toEqual([
      {
        file: "tests/shop.test.ts",
        diagnostics: [
          expect.objectContaining({ code: "unknown_option", line: 7 }),
        ],
      },
    ]);
  });
});

describe("loading TypeScript test files", () => {
  const api = pathToFileURL(
    fileURLToPath(new URL("./script-api.ts", import.meta.url)),
  ).href;
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "sedum-loader-"));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function load(name: string, source: string) {
    const target = path.join(directory, name);
    await writeFile(target, source);
    return loadScriptFile(target, { repoRoot: directory });
  }

  it("imports TypeScript and collects every test()", async () => {
    const loaded = await load(
      "typed.test.ts",
      `import { test } from ${JSON.stringify(api)};
interface User { readonly name: string }
const user: User = { name: "Ada" };
test("first " + user.name, async () => undefined);
test("second", { url: "/home" }, async ({ ai }) => { await ai("click Home"); });
`,
    );
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.tests.map((test) => [test.title, test.source.line])).toEqual([
      ["first Ada", 4],
      ["second", 5],
    ]);
  });

  it("imports each file once", async () => {
    const target = path.join(directory, "typed.test.ts");
    const [a, b] = await Promise.all([
      loadScriptFile(target, { repoRoot: directory }),
      loadScriptFile(target, { repoRoot: directory }),
    ]);
    expect(a).toBe(b);
  });

  it("reports an import that throws at the line that threw", async () => {
    const loaded = await load(
      "throws.test.ts",
      `import { test } from ${JSON.stringify(api)};

throw new Error("setup exploded");
`,
    );
    expect(loaded.tests).toEqual([]);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        code: "load_error",
        message: "The test file could not be loaded: setup exploded",
        source: expect.objectContaining({ line: 3 }),
      }),
    ]);
  });

  it("reports a syntax error and a file without tests", async () => {
    const broken = await load("broken.test.ts", "const = ;\n");
    expect(broken.diagnostics.map((item) => item.code)).toEqual(["load_error"]);
    const empty = await load("empty.test.ts", "export const nothing = 1;\n");
    expect(empty.diagnostics.map((item) => item.code)).toEqual(["no_tests"]);
  });

  it("recognizes script test files by suffix", () => {
    expect(isScriptTestFile("/a/login.test.ts")).toBe(true);
    expect(isScriptTestFile("/a/login.test.yaml")).toBe(false);
    expect(isScriptTestFile("/a/helpers.ts")).toBe(false);
  });
});
