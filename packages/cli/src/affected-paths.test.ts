import { expect, it } from "vitest";
import { affectedPathIgnored, validAffectedGlob } from "./affected-paths.js";

it.each([
  "",
  " ",
  "/absolute",
  "C:/absolute",
  "../parent",
  "docs/../parent",
  "windows\\path",
  "!negation",
  "[broken",
  "{broken",
  "broken}",
  "@(broken",
  "broken)",
])("rejects unsafe or malformed affected glob %j", (glob) => {
  expect(validAffectedGlob(glob)).toBe(false);
});
it.each([
  "docs/",
  ".github/",
  "**/.env*",
  "**/*.lock",
  "[[]pattern].ts",
  "{docs,config}/**",
  "@(docs|config)/**",
])("accepts repository POSIX glob %j", (glob) => {
  expect(validAffectedGlob(glob)).toBe(true);
});
it("matches root-relative paths, nested locks, directory descendants and dotfiles deliberately", () => {
  expect(affectedPathIgnored("nested/pnpm.lock", ["*.lock"])).toBe(false);
  expect(affectedPathIgnored("nested/pnpm.lock", ["**/*.lock"])).toBe(true);
  expect(affectedPathIgnored("pnpm.lock", ["**/*.lock"])).toBe(true);
  expect(affectedPathIgnored("docs/sub/spec.md", ["docs/"])).toBe(true);
  expect(affectedPathIgnored("nested/docs/spec.md", ["docs/"])).toBe(false);
  expect(affectedPathIgnored(".github/history.json", [".github/"])).toBe(true);
  expect(affectedPathIgnored("nested/.env.local", ["**/.env*"])).toBe(true);
  expect(affectedPathIgnored("[pattern].ts", ["[[]pattern].ts"])).toBe(true);
  expect(affectedPathIgnored("app.ts", [])).toBe(false);
});
