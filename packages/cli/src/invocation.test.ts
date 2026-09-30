import { describe, expect, it } from "vitest";
import { sedumCommand, withCommand } from "./invocation.js";

describe("sedum invocation hints", () => {
  it("detects a local install or npx, and keeps a global install bare", () => {
    expect(sedumCommand({}, "/app/node_modules/sedum-cli/dist/cli.js")).toBe(
      "npx sedum",
    );
    expect(sedumCommand({ npm_command: "exec" }, "/cache/_npx/cli.js")).toBe(
      "npx sedum",
    );
    expect(sedumCommand({}, "/usr/local/lib/sedum-cli/dist/cli.js")).toBe(
      "sedum",
    );
  });

  it("rewrites command hints only", () => {
    const text = [
      "  sedum browsers install chromium",
      "  rerun sedum run 'tests/a.test.yaml'",
      "Fix: run `sedum doctor`, then rerun.",
      "Edit sedum.config.yaml; see the sedum docs.",
      "already npx sedum run x",
    ].join("\n");
    expect(withCommand(text, "npx sedum")).toBe(
      [
        "  npx sedum browsers install chromium",
        "  rerun npx sedum run 'tests/a.test.yaml'",
        "Fix: run `npx sedum doctor`, then rerun.",
        "Edit sedum.config.yaml; see the sedum docs.",
        "already npx sedum run x",
      ].join("\n"),
    );
    expect(withCommand(text, "sedum")).toBe(text);
  });
});
