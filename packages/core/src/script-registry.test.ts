import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { describe, expect, it, test as propertyTest } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  isSecret,
  parseFrame,
  revealSecret,
  samePath,
  scriptRegistry,
  secret,
  sourceInFile,
  test,
  type SecretValue,
} from "./script-registry.js";

const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 500,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

const segment = gs.fromRegex("[A-Za-z0-9_.-]{1,12}", { fullmatch: true });

describe("script test registry", () => {
  it("records test() calls with their options and call site", () => {
    const registry = scriptRegistry();
    registry.pending = [];
    const body = async () => undefined;
    test("plain", body);
    test("with options", { url: "/login", tags: ["smoke"] }, body);
    const [plain, withOptions] = registry.pending;
    registry.pending = [];
    expect(plain).toMatchObject({ title: "plain", options: {}, body });
    expect(withOptions).toMatchObject({
      title: "with options",
      options: { url: "/login", tags: ["smoke"] },
    });
    expect(parseFrame(plain!.callSite!)?.file).toMatch(
      /script-registry\.test\.ts$/u,
    );
  });

  it("shares one registry through a global symbol", () => {
    const holder = globalThis as unknown as Record<symbol, unknown>;
    expect(holder[Symbol.for("sedum.script.registry")]).toBe(scriptRegistry());
  });

  it("recognizes a secret from another copy of the module by its symbol", () => {
    const foreign = {
      [Symbol.for("sedum.script.secret")]: () => "value",
    } as unknown as SecretValue;
    expect(isSecret(foreign)).toBe(true);
    expect(revealSecret(foreign)).toBe("value");
    expect(isSecret("value")).toBe(false);
    expect(isSecret(null)).toBe(false);
    expect(() => secret(1 as unknown as string)).toThrow(TypeError);
  });

  propertyTest("a secret never prints or serializes its value", () => {
    hegel.test((tc) => {
      const value = tc.draw(gs.text({ maxSize: 40 }));
      const hidden = secret(value);
      expect(revealSecret(hidden)).toBe(value);
      expect(String(hidden)).toBe("[secret]");
      expect(`${hidden}`).toBe("[secret]");
      expect(JSON.stringify({ hidden })).toBe('{"hidden":"[secret]"}');
      expect(inspect({ hidden })).toBe("{ hidden: [secret] }");
      expect(Object.keys(hidden)).toEqual([]);
    }, propertySettings);
  });

  propertyTest(
    "stack frames round-trip for paths, file URLs, and names",
    () => {
      hegel.test((tc) => {
        const parts = tc.draw(gs.arrays(segment, { minSize: 1, maxSize: 4 }));
        // An absolute path on this platform, such as /a/b or D:\a\b.
        const file = path.resolve("/", ...parts) + ".test.ts";
        const line = tc.draw(gs.integers({ minValue: 1, maxValue: 99_999 }));
        const col = tc.draw(gs.integers({ minValue: 1, maxValue: 999 }));
        const frame = tc.draw(
          gs.sampledFrom([
            `    at ${file}:${line}:${col}`,
            `    at Object.fn (${file}:${line}:${col})`,
            `    at async run (${pathToFileURL(file).href}:${line}:${col})`,
          ]),
        );
        expect(parseFrame(frame)).toEqual({ file, line, col });
      }, propertySettings);
    },
  );

  it("decodes file URLs with escaped characters", () => {
    const file = path.resolve("/a b/c.test.ts");
    expect(parseFrame(`    at x (${pathToFileURL(file).href}:3:4)`)).toEqual({
      file,
      line: 3,
      col: 4,
    });
    expect(parseFrame("    at native code")).toBeUndefined();
  });

  it("matches a frame path however Windows spells it", () => {
    const file = path.resolve("/project/a.test.ts");
    expect(samePath(file, file)).toBe(true);
    expect(samePath(file.replaceAll("\\", "/"), file)).toBe(true);
    expect(samePath(path.resolve("/project/b.test.ts"), file)).toBe(false);
  });

  it("finds the innermost frame inside the test file", () => {
    const stack = [
      "Error: boom",
      "    at ai (/sedum/dist/index.js:10:1)",
      "    at body (/project/a.test.ts:7:9)",
      "    at outer (/project/a.test.ts:3:1)",
    ].join("\n");
    expect(sourceInFile(stack, "/project/a.test.ts")).toEqual({
      file: "/project/a.test.ts",
      line: 7,
      col: 9,
    });
    expect(sourceInFile(stack, "/project/b.test.ts")).toBeUndefined();
    expect(sourceInFile(undefined, "/project/a.test.ts")).toBeUndefined();
  });
});
