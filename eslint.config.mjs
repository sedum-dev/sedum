import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/release/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
      },
    },
  },
);
