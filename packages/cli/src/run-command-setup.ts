import path from "node:path";
import {
  loadProjectConfig,
  ProjectConfigError,
  type ResolvedProjectConfig,
} from "./config.js";
import type { BrowserKind } from "@sedum-dev/core";
import type { RunCommandOptions } from "./run-command.js";

const SUPPORTED_BROWSERS = new Set(["chrome", "chromium"]);

export async function resolveRunConfig(
  invocationRoot: string,
  options: RunCommandOptions,
): Promise<ResolvedProjectConfig> {
  validateBrowser(invocationRoot, options.browser);
  validateUrlOverride(invocationRoot, options.urlOverride);
  const config = await loadProjectConfig(invocationRoot, process.env, {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.browser ? { browser: options.browser as BrowserKind } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
    ...(options.reporterDir ? { reporterDir: options.reporterDir } : {}),
    ...visionOverride(options),
  });
  validateVisionKey(config);
  return config;
}

function validateBrowser(invocationRoot: string, browser?: string): void {
  if (!browser) return;
  if (SUPPORTED_BROWSERS.has(browser)) return;
  throw new ProjectConfigError([
    {
      code: "invalid_browser",
      file: path.join(invocationRoot, "sedum.config.yaml"),
      line: 1,
      col: 1,
      key: "browser",
      message: "Browser must be chrome or chromium.",
      fix: "Use --browser chrome or --browser chromium.",
    },
  ]);
}

function validateUrlOverride(invocationRoot: string, override?: string): void {
  if (!override) return;
  if (isValidOverride(override)) return;
  throw new ProjectConfigError([
    {
      code: "invalid_url_override",
      file: path.join(invocationRoot, "sedum.config.yaml"),
      line: 1,
      col: 1,
      key: "urlOverride",
      message:
        "The URL override must be an absolute HTTP(S) URL without credentials.",
      fix: "Use --url-override https://preview.example.com.",
    },
  ]);
}

function isValidOverride(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function visionOverride(options: RunCommandOptions): object {
  if (options.vision === undefined && options.visionModel === undefined)
    return {};
  return {
    vision: {
      ...(options.vision !== undefined ? { enabled: options.vision } : {}),
      ...(options.visionModel !== undefined
        ? { model: options.visionModel }
        : {}),
    },
  };
}

function validateVisionKey(config: ResolvedProjectConfig): void {
  if (!config.vision.enabled) return;
  if (config.visionApiKey) return;
  throw new ProjectConfigError([
    {
      code: "missing_vision_api_key",
      file: path.join(config.projectRoot, ".env"),
      line: 1,
      col: 1,
      key: "OPEN_ROUTER_API_KEY",
      message: "Vision fallback requires OPEN_ROUTER_API_KEY.",
      fix: "Set OPEN_ROUTER_API_KEY in the invoking process or project-root .env, or disable vision.",
    },
  ]);
}
