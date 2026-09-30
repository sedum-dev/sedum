/**
 * The public authoring entry for `*.test.ts` files:
 *
 *     import { test, expect, secret } from "sedum-cli";
 *
 * It is a separate entry so the CLI does not load Playwright's `expect`
 * unless a test file asks for it.
 */
export { test, secret } from "./script-registry.js";
export type {
  Ai,
  AiValue,
  AiValues,
  Parser,
  SecretValue,
  TestBody,
  TestContext,
  TestInfo,
  TestOptions,
} from "./script-registry.js";
export { expect } from "playwright/test";
export type { Page, BrowserContext, Locator } from "playwright-core";
