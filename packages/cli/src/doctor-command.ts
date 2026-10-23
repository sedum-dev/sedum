import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findBrowserExecutable, type BrowserKind } from "@sedum-dev/core";
import {
  probeTypeSafeApiKey,
  type AuthProbeResult,
} from "@sedum-dev/provider-typesafe";
import {
  DEFAULT_PROVIDER_BASE_URL,
  DEFAULT_PROVIDER_MODEL,
  loadProjectConfig,
  ProjectConfigError,
  type ProjectConfigOverrides,
  type ResolvedProjectConfig,
} from "./config.js";
import { providerDiagnostic } from "./diagnostics.js";

const CLOUDFLARE_API = "https://api.cloudflare.com";

export type DoctorCheckId =
  | "node"
  | "config"
  | "browser"
  | "api_network"
  | "api_key"
  | "api_auth"
  | "vision"
  | "output";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly status: "pass" | "fail";
  readonly message: string;
  readonly fix: string | null;
}

export interface DoctorResult {
  readonly schemaVersion: 1;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorProbes {
  readonly nodeVersion?: string;
  readonly loadConfig?: (cwd: string) => Promise<ResolvedProjectConfig>;
  readonly browser?: (kind: BrowserKind) => boolean;
  readonly network?: (baseURL: string) => Promise<boolean>;
  readonly auth?: (
    apiKey: string,
    options: { readonly baseURL: string; readonly model: string },
  ) => Promise<AuthProbeResult>;
  readonly output?: (config: ResolvedProjectConfig) => Promise<void>;
}

export interface DoctorOptions {
  readonly environment?: string;
  readonly browser?: BrowserKind;
}

/** Doctor options from the parsed `doctor` command line. */
export function doctorOptions(options: {
  env?: string;
  browser?: string;
}): DoctorOptions {
  return {
    ...(options.env ? { environment: options.env } : {}),
    ...(options.browser ? { browser: options.browser as BrowserKind } : {}),
  };
}

const pass = (id: DoctorCheckId, message: string): DoctorCheck => ({
  id,
  status: "pass",
  message,
  fix: null,
});
const fail = (
  id: DoctorCheckId,
  message: string,
  fix: string,
): DoctorCheck => ({
  id,
  status: "fail",
  message,
  fix,
});

export function supportedNode(version: string): boolean {
  const parts = version.split(".").map(Number);
  return (
    parts.length >= 3 &&
    parts.every(Number.isSafeInteger) &&
    (parts[0]! > 20 ||
      (parts[0] === 20 &&
        (parts[1]! > 19 || (parts[1] === 19 && parts[2]! >= 0))))
  );
}

export function browserAvailable(kind: BrowserKind): boolean {
  return findBrowserExecutable(kind) !== null;
}

export function keyPresent(config: ResolvedProjectConfig): boolean {
  return Boolean(
    config.apiKey?.trim() &&
    (config.providerName !== "clef" || config.cloudflareAccountId?.trim()),
  );
}

async function networkReachable(baseURL: string): Promise<boolean> {
  try {
    // Any HTTP response proves DNS, TLS and HTTP reachability.
    await fetch(baseURL, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Probe a real write while honoring the same path and symlink rules as ProgressWriter. */
export async function checkOutputWritable(
  config: ResolvedProjectConfig,
): Promise<void> {
  const root = path.resolve(config.projectRoot);
  const base = path.resolve(config.outputDir);
  const relative = path.relative(root, base);
  if (relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("output path escapes project root");
  const created: string[] = [];
  let temporary: string | undefined;
  try {
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        await mkdir(current, { mode: 0o700 });
        created.push(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("output path is not a regular directory");
    }
    temporary = await mkdtemp(path.join(base, ".doctor-"));
    await writeFile(path.join(temporary, "write-probe"), "ok", {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    for (const directory of created.reverse()) {
      await rmdir(directory).catch(() => undefined);
    }
  }
}

/** Vision fallback reads a screenshot with the provider's image model. */
const VISION_CHECKS = {
  ready: pass(
    "vision",
    "Vision fallback will send screenshots to the provider's image model.",
  ),
  blocked: fail(
    "vision",
    "Vision fallback is enabled but screenshots are off, so it cannot run.",
    "Use the TypeSafe API with screenshots on (the default there), or set vision.enabled: false.",
  ),
};

function browserOrigin(config: ResolvedProjectConfig): string {
  return config.browserSource === "default"
    ? "the default"
    : `from ${config.browserSource}`;
}

function configOverrides(options: DoctorOptions): ProjectConfigOverrides {
  return {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.browser ? { browser: options.browser } : {}),
  };
}

/** The config check for a configuration that did not load, naming its first problem. */
function configFailure(error: unknown): DoctorCheck {
  const detail =
    error instanceof ProjectConfigError ? error.diagnostics[0] : undefined;
  if (!detail)
    return fail(
      "config",
      "Project configuration could not be loaded.",
      "Correct sedum.config.yaml or the project-root .env and check file permissions.",
    );
  return fail(
    "config",
    `Project configuration could not be loaded: ${detail.message}`,
    detail.fix,
  );
}

export async function executeDoctorCommand(
  cwd: string,
  probes: DoctorProbes = {},
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const version = probes.nodeVersion ?? process.versions.node;
  checks.push(
    supportedNode(version)
      ? pass("node", `Node ${version} meets the >=20.19.0 requirement.`)
      : fail(
          "node",
          `Node ${version} is too old or invalid.`,
          "Install Node 20.19.0 or newer.",
        ),
  );

  let config: ResolvedProjectConfig | null = null;
  try {
    config = probes.loadConfig
      ? await probes.loadConfig(cwd)
      : await loadProjectConfig(cwd, process.env, configOverrides(options));
    checks.push(pass("config", "Project configuration is valid."));
  } catch (error) {
    checks.push(configFailure(error));
  }

  if (config) {
    try {
      const available = (probes.browser ?? browserAvailable)(config.browser);
      checks.push(
        available
          ? pass(
              "browser",
              `${config.browser} is available (${browserOrigin(config)}).`,
            )
          : fail(
              "browser",
              `${config.browser} was not found (${browserOrigin(config)}).`,
              "Install Chrome or run `sedum browsers install chromium`; check the configured browser.",
            ),
      );
    } catch {
      checks.push(
        fail(
          "browser",
          "Browser availability could not be checked.",
          "Check the browser installation and retry.",
        ),
      );
    }
  } else {
    checks.push(
      fail(
        "browser",
        "Configured browser is unknown.",
        "Fix project configuration, then rerun doctor.",
      ),
    );
  }

  const providerBaseUrl =
    config?.providerName === "clef"
      ? CLOUDFLARE_API
      : (config?.providerBaseUrl ?? DEFAULT_PROVIDER_BASE_URL);
  const providerModel = config?.providerModel ?? DEFAULT_PROVIDER_MODEL;
  let network = false;
  try {
    network = await (probes.network ?? networkReachable)(providerBaseUrl);
  } catch {
    network = false;
  }
  checks.push(
    network
      ? pass("api_network", "Model provider API is reachable.")
      : fail(
          "api_network",
          "Model provider API could not be reached.",
          `Check DNS, TLS, proxy, firewall, and access to ${providerBaseUrl}.`,
        ),
  );

  const key = config && keyPresent(config) ? config.apiKey?.trim() : undefined;
  checks.push(
    !config
      ? fail(
          "api_key",
          "API key source could not be read.",
          "Fix project configuration, then rerun doctor.",
        )
      : key
        ? pass("api_key", "Provider API key is present.")
        : fail(
            "api_key",
            "Provider API key is missing.",
            providerDiagnostic(config, "configuration").fix,
          ),
  );

  if (!config)
    checks.push(
      fail(
        "api_auth",
        "API authentication could not be checked.",
        "Fix project configuration, then rerun doctor.",
      ),
    );
  else if (!key)
    checks.push(
      fail(
        "api_auth",
        "API authentication could not be checked without a key.",
        providerDiagnostic(config, "configuration").fix,
      ),
    );
  else if (!network)
    checks.push(
      fail(
        "api_auth",
        "API authentication could not be checked without API access.",
        "Restore model provider API network access, then rerun doctor.",
      ),
    );
  else {
    let result: AuthProbeResult;
    try {
      if (config.providerName === "clef") {
        result = probes.auth
          ? await probes.auth(key, {
              baseURL: providerBaseUrl,
              model: providerModel,
            })
          : await (
              await import("@sedum-dev/provider-clef")
            ).probeClefApiKey(key, {
              accountId: config.cloudflareAccountId!,
              model: providerModel,
            });
      } else
        result = await (probes.auth ?? probeTypeSafeApiKey)(key, {
          baseURL: providerBaseUrl,
          model: providerModel,
        });
    } catch {
      result = "unavailable";
    }
    checks.push(
      result === "accepted"
        ? pass(
            "api_auth",
            config.providerName === "clef"
              ? "Cloudflare completed the explicitly billable inference probe."
              : "Model provider API accepted the key.",
          )
        : result === "rejected"
          ? fail(
              "api_auth",
              providerDiagnostic(config, "authentication").message,
              providerDiagnostic(config, "authentication").fix,
            )
          : result === "unreachable"
            ? fail(
                "api_auth",
                "Authenticated provider request could not reach the API.",
                "Check the API connection and retry.",
              )
            : fail(
                "api_auth",
                "The model provider could not complete the authentication probe.",
                config.providerName === "clef"
                  ? "Check Cloudflare API availability, CLOUDFLARE_ACCOUNT_ID, and Workers AI access, then retry."
                  : "Check API availability and account access, then retry.",
              ),
    );
  }

  if (config?.vision.enabled)
    checks.push(VISION_CHECKS[config.screenshots ? "ready" : "blocked"]);

  if (config) {
    try {
      await (probes.output ?? checkOutputWritable)(config);
      checks.push(pass("output", "Output directory is writable."));
    } catch {
      checks.push(
        fail(
          "output",
          "Output directory is not writable or safe.",
          "Choose a writable, non-symlinked outputDir inside the project root and check permissions.",
        ),
      );
    }
  } else {
    checks.push(
      fail(
        "output",
        "Configured output directory is unknown.",
        "Fix project configuration, then rerun doctor.",
      ),
    );
  }

  return { schemaVersion: 1, checks };
}

export function renderDoctorText(result: DoctorResult): string {
  return result.checks
    .map(
      (check) =>
        `${check.status === "pass" ? "PASS" : "FAIL"} ${check.id}: ${check.message}${check.fix ? `\n  Fix: ${check.fix}` : ""}\n`,
    )
    .join("");
}
