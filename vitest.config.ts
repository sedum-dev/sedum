import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/core/src/page-script/**",
        "packages/*/src/index.ts",
        "packages/cli/src/cli.ts",
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
