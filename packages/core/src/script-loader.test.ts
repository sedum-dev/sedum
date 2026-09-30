import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import { NoopClassificationCache } from "./classification-cache.js";
import { listTests } from "./project-listing.js";
import { validateProject } from "./project-validation.js";
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

  it.each(["importer first", "imported first"])(
    "keeps each test in its own file when one test file imports another (%s)",
    async (order) => {
      const folder = path.join(directory, order.replace(" ", "-"));
      await mkdir(folder);
      const login = path.join(folder, "login.test.ts");
      const checkout = path.join(folder, "checkout.test.ts");
      await writeFile(
        login,
        `import { test } from ${JSON.stringify(api)};
export const user = "Ada";
test("a user logs in", async () => undefined);
`,
      );
      await writeFile(
        checkout,
        `import { test } from ${JSON.stringify(api)};
import { user } from "./login.test.ts";
test("checks out as " + user, async () => undefined);
`,
      );
      const files =
        order === "importer first" ? [checkout, login] : [login, checkout];
      const loaded = new Map<
        string,
        Awaited<ReturnType<typeof loadScriptFile>>
      >();
      for (const file of files)
        loaded.set(file, await loadScriptFile(file, { repoRoot: folder }));
      expect(loaded.get(login)!.diagnostics).toEqual([]);
      expect(loaded.get(checkout)!.diagnostics).toEqual([]);
      expect(
        loaded
          .get(login)!
          .tests.map((test) => [test.identity, test.source.line]),
      ).toEqual([["login.test.ts#a user logs in", 3]]);
      expect(loaded.get(checkout)!.tests.map((test) => test.identity)).toEqual([
        "checkout.test.ts#checks out as Ada",
      ]);
    },
  );

  it.each(["first user first", "second user first"])(
    "keeps tests declared through a shared wrapper in the test files that call it (%s)",
    async (order) => {
      const folder = path.join(
        directory,
        `wrapper-${order.replaceAll(" ", "-")}`,
      );
      await mkdir(path.join(folder, "support"), { recursive: true });
      await writeFile(
        path.join(folder, "support", "smoke.ts"),
        `import { test, type TestBody } from ${JSON.stringify(api)};
export function smoke(title: string, body: TestBody) {
  test(title, { tags: ["smoke"] }, body);
}
`,
      );
      const one = path.join(folder, "one.test.ts");
      const two = path.join(folder, "two.test.ts");
      await writeFile(
        one,
        `import { smoke } from "./support/smoke.js";\nsmoke("one", async () => undefined);\n`,
      );
      await writeFile(
        two,
        `import { smoke } from "./support/smoke.js";\nsmoke("two a", async () => undefined);\nsmoke("two b", async () => undefined);\n`,
      );
      const files = order === "first user first" ? [one, two] : [two, one];
      const loaded = new Map<
        string,
        Awaited<ReturnType<typeof loadScriptFile>>
      >();
      for (const target of files)
        loaded.set(target, await loadScriptFile(target, { repoRoot: folder }));
      expect(
        loaded
          .get(one)!
          .tests.map((test) => [test.identity, test.source.line, test.tags]),
      ).toEqual([["one.test.ts#one", 2, ["smoke"]]]);
      expect(
        loaded.get(two)!.tests.map((test) => [test.identity, test.source.line]),
      ).toEqual([
        ["two.test.ts#two a", 2],
        ["two.test.ts#two b", 3],
      ]);
      expect([...loaded.values()].flatMap((file) => file.diagnostics)).toEqual(
        [],
      );
    },
  );

  it("files a test declared through a wrapper exported by another test file under the caller", async () => {
    const folder = path.join(directory, "cross-wrapper");
    await mkdir(folder);
    const home = path.join(folder, "home.test.ts");
    const page = path.join(folder, "page.test.ts");
    await writeFile(
      home,
      `import { test, type TestBody } from ${JSON.stringify(api)};
export function smoke(title: string, body: TestBody) {
  test(title, { tags: ["smoke"] }, body);
}
smoke("home loads", async () => undefined);
`,
    );
    await writeFile(
      page,
      `import { smoke } from "./home.test.ts";\nsmoke("a page loads", async () => undefined);\n`,
    );
    const second = await loadScriptFile(page, { repoRoot: folder });
    const first = await loadScriptFile(home, { repoRoot: folder });
    expect(
      second.tests.map((test) => [test.identity, test.source.line]),
    ).toEqual([["page.test.ts#a page loads", 2]]);
    expect(
      first.tests.map((test) => [test.identity, test.source.line]),
    ).toEqual([["home.test.ts#home loads", 5]]);
  });

  // Importing a 70-module chain is slow on Windows runners.
  it("warns when a test imports more helpers than validation follows", async () => {
    const folder = path.join(directory, "many-helpers");
    await mkdir(folder);
    for (let index = 0; index < 70; index++)
      await writeFile(
        path.join(folder, `h${index}.ts`),
        index < 69
          ? `import "./h${index + 1}.js";\n`
          : 'export const late = () => ai("");\n',
      );
    const test = path.join(folder, "deep.test.ts");
    await writeFile(
      test,
      `import { test } from ${JSON.stringify(api)};\nimport "./h0.js";\ntest("deep", async () => undefined);\n`,
    );
    const result = await validateProject(
      { tests: [test], modules: [] },
      {
        repoRoot: folder,
        mode: "offline",
        cache: new NoopClassificationCache(),
      },
    );
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "too_many_helpers",
    );
    expect(result.fullyValidated).toBe(false);
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "does not follow a helper symlinked from outside the project",
    async () => {
      const folder = path.join(directory, "linked");
      const outside = path.join(directory, "outside-project");
      await mkdir(folder);
      await mkdir(outside);
      await writeFile(
        path.join(outside, "steps.ts"),
        'export const x = () => ai("");\n',
      );
      await symlink(
        path.join(outside, "steps.ts"),
        path.join(folder, "steps.ts"),
      );
      const test = path.join(folder, "linked.test.ts");
      await writeFile(
        test,
        `import { test } from ${JSON.stringify(api)};\nimport "./steps.js";\ntest("linked", async () => undefined);\n`,
      );
      const result = await validateProject(
        { tests: [test], modules: [] },
        {
          repoRoot: folder,
          mode: "offline",
          cache: new NoopClassificationCache(),
        },
      );
      expect(result.diagnostics).toEqual([]);
    },
  );

  it("validates sentences in imported helpers and never calls unread arguments valid", async () => {
    const folder = path.join(directory, "validate");
    await mkdir(path.join(folder, "support"), { recursive: true });
    const test = path.join(folder, "shop.test.ts");
    await writeFile(
      path.join(folder, "support", "steps.ts"),
      `import type { Ai } from ${JSON.stringify(api)};
export async function login(ai: Ai, steps: string[]) {
  await ai("");
  await ai(steps);
}
`,
    );
    await writeFile(
      test,
      `import { test } from ${JSON.stringify(api)};
import { login } from "./support/steps.js";
test("shop", async ({ ai }) => { await login(ai, ["click Login"]); });
`,
    );
    const result = await validateProject(
      { tests: [test], modules: [] },
      {
        repoRoot: folder,
        mode: "offline",
        cache: new NoopClassificationCache(),
      },
    );
    expect(
      result.diagnostics.map((item) => [
        path.basename(item.source.file),
        item.source.line,
        item.severity,
        item.code,
      ]),
    ).toEqual([
      ["steps.ts", 3, "error", "empty"],
      ["steps.ts", 4, "warning", "dynamic_sentence"],
    ]);
    expect(result.fullyValidated).toBe(false);
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
