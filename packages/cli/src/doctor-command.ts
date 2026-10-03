import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  findBrowserExecutable,
  probeOpenRouterKey,
  type BrowserKind,
  type VisionKeyProbe,
} from "@sedum-dev/core";
import {
  probeTypeSafeApiKey,
  type AuthProbeResult,
} from "@sedum-dev/provider-typesafe";
import {
  DEFAULT_PROVIDER_BASE_URL,
  DEFAULT_PROVIDER_MODEL,
  loadProjectConfig,
  type ResolvedProjectConfig,
} from "./config.js";

const CLOUDFLARE_API = "https://api.cloudflare.com";

export type DoctorCheckId =
  | "node"
  | "config"
  | "browser"
  | "api_network"
  | "api_key"
  | "api_auth"
  | "vision_key"
  | "vision_auth"
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
  readonly visionAuth?: (apiKey: string) => Promise<VisionKeyProbe>;
}

export interface DoctorOptions {
  /** Check the vision fallback's OpenRouter key even when config leaves it off. */
  readonly vision?: boolean;
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
    config = await (probes.loadConfig ?? loadProjectConfig)(cwd);
    checks.push(pass("config", "Project configuration is valid."));
  } catch {
    checks.push(
      fail(
        "config",
        "Project configuration could not be loaded.",
        "Correct sedum.config.yaml or the project-root .env and check file permissions.",
      ),
    );
  }

  if (config) {
    try {
      const available = (probes.browser ?? browserAvailable)(config.browser);
      checks.push(
        available
          ? pass("browser", `${config.browser} is available.`)
          : fail(
              "browser",
              `${config.browser} was not found.`,
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
            config.providerName === "clef"
              ? "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN)."
              : "Set TYPESAFE_API_KEY for the configured endpoint.",
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
        config.providerName === "clef"
          ? "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN), then rerun doctor."
          : "Set TYPESAFE_API_KEY, then rerun doctor.",
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
              config.providerName === "clef"
                ? "Cloudflare rejected the configured API token."
                : "Model provider API rejected the key.",
              config.providerName === "clef"
                ? "Check CLOUDFLARE_ACCOUNT_ID, then replace CLOUDFLARE_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN) with a token for that account that has Workers AI Read and Edit permissions."
                : "Replace TYPESAFE_API_KEY with a valid key and rerun doctor.",
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

  if (config && (options.vision || config.vision.enabled)) {
    const visionKey = config.visionApiKey?.trim();
    checks.push(
      visionKey
        ? pass(
            "vision_key",
            "OpenRouter API key for vision fallback is present.",
          )
        : fail(
            "vision_key",
            "Vision fallback is enabled but OPEN_ROUTER_API_KEY is missing.",
            "Set OPEN_ROUTER_API_KEY in the environment or the project-root .env.",
          ),
    );
    if (visionKey) {
      const result = await (probes.visionAuth ?? probeOpenRouterKey)(
        visionKey,
      ).catch((): VisionKeyProbe => "unreachable");
      checks.push(
        result === "accepted"
          ? pass("vision_auth", "OpenRouter accepted the vision key.")
          : result === "rejected"
            ? fail(
                "vision_auth",
                "OpenRouter rejected OPEN_ROUTER_API_KEY.",
                "Replace OPEN_ROUTER_API_KEY with a valid OpenRouter key and rerun doctor.",
              )
            : fail(
                "vision_auth",
                "OpenRouter could not be reached to check the vision key.",
                "Check access to https://openrouter.ai and retry.",
              ),
      );
    } else
      checks.push(
        fail(
          "vision_auth",
          "The vision key could not be checked without a key.",
          "Set OPEN_ROUTER_API_KEY, then rerun doctor.",
        ),
      );
  }

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
